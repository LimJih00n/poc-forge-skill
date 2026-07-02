// s2-plan · 내부 단계 오케스트레이션
//   IN : runs/<project>/context.json (+ understanding.md, sources/) ← S1 산출
//   OUT: spec.json(기계) + features.md(기능정의서 표) + prd.md(내러티브 PRD)
//   흐름: load → LLM1(spec, 스키마 강제) → guard → LLM2(prd, 프로즈) → render features.md → commit
//   사용: node run.mjs <project|경로>     LLM 스왑: POC_FORGE_LLM_CMD

import { readFileSync, readdirSync, writeFileSync, appendFileSync, statSync, existsSync, rmSync } from "node:fs";
import { join, resolve, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateSpec, validateSpecPlan, validateEnrichedGroup } from "./guard.mjs";
import { groupFeatures, parseJsonlLines, doneGroupKeys, assembleFeatures, featureCoverage } from "./chunk.mjs";
import { fingerprint, stampMeta, commitRun, stalenessWarnings } from "../../lib/version.mjs";
import { cleanMarkdownDoc } from "../../lib/clean.mjs";
import { callLLM, generateJson } from "../../lib/llm.mjs";

const SKILL_DIR = fileURLToPath(new URL(".", import.meta.url));
const TEXT_EXT = new Set([".md", ".txt", ".csv", ".tsv", ".json", ".log", ""]);

function resolveProjectDir(arg) {
  if (!arg) throw new Error("프로젝트를 지정하세요: node run.mjs <project|경로>  (예: node run.mjs gearloan)");
  if (arg.includes("/") || arg.includes("\\")) return resolve(arg);
  return resolve(SKILL_DIR, "..", "..", "runs", arg);
}

// 원자료(readable) 코퍼스 — S2는 digest(context.json)뿐 아니라 원자료 전체도 본다(자세한 granularity 위해).
function readReadableCorpus(sourcesDir) {
  if (!existsSync(sourcesDir)) return { corpus: "", readable: [] };
  const readable = [];
  let corpus = "";
  for (const f of readdirSync(sourcesDir).filter((x) => statSync(join(sourcesDir, x)).isFile()).sort()) {
    if (!TEXT_EXT.has(extname(f).toLowerCase())) continue;
    corpus += `\n\n===== FILE: ${f} =====\n${readFileSync(join(sourcesDir, f), "utf8")}\n`;
    readable.push(f);
  }
  return { corpus, readable };
}

// LLM 호출(callLLM) + 견고 JSON 생성(generateJson, 잘림 감지+재시도) + PRD 프로즈 정리 = 공용 lib.

// features.md = BigShift 기능정의서 표 (구분>대분류 섹션 + 표) + 정책/NFR/오픈이슈.
function renderFeaturesMd(spec) {
  const cell = (v) => (Array.isArray(v) ? v.join(", ") : v ?? "").toString().replace(/\|/g, " /").replace(/\n+/g, " ").trim();
  const badge = { confirmed: "✅확정", proposed: "🟡제안", open: "❓미정" };
  const L = [];
  L.push(`# 기능정의서 — ${spec.project}`, "");
  L.push("> S2(plan) 산출 · BigShift 기능정의서 포맷(행 단위). 기계본 = `spec.json` · 내러티브 = `prd.md`.", "");
  if (spec.product) {
    L.push(`**제품**: ${spec.product.name || spec.project} — ${spec.product.goal || ""}`);
    if (spec.product.northStar) L.push("", `> ${spec.product.northStar}`);
    L.push("");
  }

  const byGubun = {};
  for (const f of spec.features) {
    const g = f.구분 || "-", d = f.대분류 || "-";
    (byGubun[g] ??= {});
    (byGubun[g][d] ??= []).push(f);
  }
  for (const [g, ds] of Object.entries(byGubun)) {
    L.push(`## ${g}`, "");
    for (const [d, rows] of Object.entries(ds)) {
      L.push(`### ${d}`, "");
      L.push("| 중분류 | 기능(항목) | 상세내용 | 화면후보 | 참조데이터 | 범위 | As-is | 우선순위 | 상태 | 근거 |");
      L.push("|---|---|---|---|---|---|---|---|---|---|");
      for (const f of rows)
        L.push(
          `| ${cell(f.중분류)} | ${cell(f.기능)} | ${cell(f.상세내용)} | ${cell(f.화면후보)} | ${cell(f.참조데이터)} | ` +
            `${cell(f.제공범위)} | ${cell(f.asIs)} | ${cell(f.priority)} | ${badge[f.status] || cell(f.status)} | ${cell(f.sources)} |`
        );
      L.push("");
    }
  }

  if (spec.businessRules?.length) {
    L.push("## 정책 · 비즈니스 규칙", "");
    for (const r of spec.businessRules)
      L.push(`- ${cell(r.rule)}${r.sources?.length ? ` _(근거: ${r.sources.join(", ")})_` : ""}`);
    L.push("");
  }
  if (spec.nfr?.length) {
    L.push("## 비기능 요구 (NFR)", "");
    for (const n of spec.nfr)
      L.push(`- **[${cell(n.category)}]** ${cell(n.requirement)}${n.sources?.length ? ` _(근거: ${n.sources.join(", ")})_` : ""}`);
    L.push("");
  }
  const openQ = (spec.openQuestions || []).filter((q) => q.status !== "answered");
  if (openQ.length) {
    L.push("## ❓ 오픈 이슈 (기획 확정 필요)", "");
    for (const q of openQ) L.push(`- ${cell(q.item)} — ${cell(q.reason)}`);
    L.push("");
  }
  if (spec._meta)
    L.push("---", "", `_생성: ${spec._meta.generatedAt} · 기능 ${spec.features.length}행 · 지문 \`${spec._meta.inputsFingerprint}\`_`, "");
  return L.join("\n");
}

// ── --chunked: "아웃라인-완결 → 대분류별 상세화 + jsonl 체크포인트" (S4/S5식 누적/append) ─────────
//   출력 한도 근접(features 100행 ≈ 33K토큰)을 구조적으로 회피 + 중간 사망 시 완료 그룹 보존(resume).
//   커버리지는 plan(아웃라인)에서 한 응집 콜로 고정 → 상세화는 1:1 확장이라 조용한 드롭 불가(featureCoverage hard).
async function genSpecChunked({ projectDir, project, context, ctxObj, corpus, readable, realFiles, resume }) {
  const planPath = join(projectDir, ".s2-plan.json"); // 중간 산출(아웃라인) — .s2- 접두라 gitignore
  const jsonlPath = join(projectDir, ".s2-features.jsonl");

  // 1) plan (아웃라인-완결). resume 면 기존 plan 재사용(같은 체크포인트를 이어야 하므로 재생성 안 함).
  let plan;
  if (resume) {
    if (!existsSync(planPath)) throw new Error(`--resume 인데 .s2-plan.json 없음 — 먼저 fresh: node run.mjs ${project} --chunked`);
    plan = JSON.parse(readFileSync(planPath, "utf8"));
    console.error(`[s2] --chunked --resume: 기존 plan 재사용(기능 ${plan.features.length}행)`);
  } else {
    if (existsSync(jsonlPath)) rmSync(jsonlPath); // fresh = 이전 체크포인트 폐기(다른 plan)
    const planPrompt = readFileSync(join(SKILL_DIR, "prompt-spec-plan.md"), "utf8")
      .replaceAll("{{PROJECT}}", project).replace("{{CONTEXT}}", context).replace("{{CORPUS}}", corpus);
    console.error("[s2] --chunked 1/2 — plan (아웃라인-완결, taxonomy 확정)…");
    const rPlan = await generateJson({
      basePrompt: planPrompt,
      saveRaw: (raw) => writeFileSync(join(projectDir, ".s2-plan-raw.txt"), raw),
      stamp: (o) => { o.project = project; },
      validate: (o) => validateSpecPlan(o),
      attempts: 3,
      log: (m) => console.error(`[s2]   ${m}`),
    });
    if (!rPlan.gv.ok) {
      if (rPlan.obj) writeFileSync(join(projectDir, "spec.plan.invalid.json"), JSON.stringify(rPlan.obj, null, 2));
      console.error(`[s2] plan 가드 실패(${rPlan.attempt}시도)${rPlan.truncated ? " · 잘림" : ""} → spec.plan.invalid.json:`);
      for (const e of rPlan.gv.errors) console.error("  - " + e);
      process.exit(1);
    }
    plan = rPlan.obj;
    writeFileSync(planPath, JSON.stringify(plan, null, 2));
  }
  const groups = groupFeatures(plan.features);
  console.error(`[s2]   ✓ plan: 기능 ${plan.features.length}행 · 대분류 그룹 ${groups.length}`);

  // 2) 대분류별 상세화 (jsonl append + resume: 완료 그룹 skip)
  const already = existsSync(jsonlPath) ? parseJsonlLines(readFileSync(jsonlPath, "utf8")) : [];
  const done = doneGroupKeys(groups, already);
  if (done.size) console.error(`[s2]   체크포인트: 완료 그룹 ${done.size}/${groups.length} skip`);
  const productStr = JSON.stringify(plan.product || {}, null, 2);
  const enrichTmpl = readFileSync(join(SKILL_DIR, "prompt-spec-enrich.md"), "utf8");
  let gi = 0;
  for (const g of groups) {
    gi++;
    if (done.has(g.key)) continue;
    const outlineIds = new Set(g.rows.map((r) => r.id));
    const prompt = enrichTmpl
      .replace("{{PRODUCT}}", productStr)
      .replace("{{GROUP}}", JSON.stringify(g.rows, null, 2))
      .replace("{{CONTEXT}}", context)
      .replace("{{CORPUS}}", corpus);
    console.error(`[s2] --chunked 2/2 — 상세화 ${gi}/${groups.length}: ${g.구분}/${g.대분류} (${g.rows.length}행)…`);
    const rEnr = await generateJson({
      basePrompt: prompt,
      saveRaw: (raw) => writeFileSync(join(projectDir, ".s2-enrich-raw.txt"), raw),
      validate: (o) => validateEnrichedGroup(o, { outlineIds, realFiles, label: `${g.구분}/${g.대분류}` }),
      attempts: 3,
      log: (m) => console.error(`[s2]   ${m}`),
    });
    if (!rEnr.gv.ok) {
      writeFileSync(join(projectDir, "spec.enrich.invalid.json"), JSON.stringify(rEnr.obj || {}, null, 2));
      console.error(`[s2] 상세화 가드 실패(${g.구분}/${g.대분류}, ${rEnr.attempt}시도)${rEnr.truncated ? " · 잘림" : ""}:`);
      for (const e of rEnr.gv.errors) console.error("  - " + e);
      console.error(`  (완료분은 ${basename(jsonlPath)}에 보존 — 고친 뒤  node run.mjs ${project} --chunked --resume  로 이어서)`);
      process.exit(1);
    }
    const rows = rEnr.obj.features.map((f) => ({ _group: g.key, ...f }));
    appendFileSync(jsonlPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    console.error(`[s2]   ✓ ${g.구분}/${g.대분류}: ${rows.length}행 append`);
  }

  // 3) 조립 + 전체 가드 + 커버리지 플로어(조용한 드롭 hard)
  const enriched = parseJsonlLines(readFileSync(jsonlPath, "utf8"));
  const features = assembleFeatures(plan.features, enriched);
  const spec = { ...plan, features, project };
  const gv = validateSpec(spec, { realFiles, readable, context: ctxObj });
  for (const w of (gv.warnings || [])) console.error(`[s2][warn] ${w}`);
  const cov = featureCoverage(plan.features, features);
  if (!gv.ok || !cov.ok) {
    writeFileSync(join(projectDir, "spec.invalid.json"), JSON.stringify(spec, null, 2));
    console.error("[s2] 조립 가드 실패 → spec.invalid.json:");
    for (const e of [...(gv.ok ? [] : gv.errors), ...cov.errors]) console.error("  - " + e);
    console.error(`  (체크포인트 ${basename(jsonlPath)} 유지 — 원인 수정 후  --chunked --resume  재실행)`);
    process.exit(1);
  }
  console.error(`[s2]   ✓ 조립: 기능 ${features.length}행 (plan ${cov.planCount} 전부 커버) · 대분류 그룹 ${groups.length}`);
  return { spec, gv };
}

async function main() {
  const args = process.argv.slice(2);
  const projectArg = args.find((a) => !a.startsWith("-"));
  const chunked = args.includes("--chunked");
  const resume = args.includes("--resume");
  const projectDir = resolveProjectDir(projectArg);
  const project = basename(projectDir);
  const contextPath = join(projectDir, "context.json");
  if (!existsSync(contextPath))
    throw new Error(`context.json 없음 — 먼저 S1 실행: node skills/s1-understand/run.mjs ${project}`);

  const context = readFileSync(contextPath, "utf8");
  const ctxObj = JSON.parse(context);
  const { corpus, readable } = readReadableCorpus(join(projectDir, "sources"));
  const realFiles = (ctxObj.assets || []).map((a) => a.file);
  console.error(`[s2] load: context.json + 원자료 ${readable.length}개`);
  for (const w of stalenessWarnings(projectDir)) console.error(`[s2][stale] ${w}`);

  // ── spec.json 생성: --chunked(누적/append, 큰 프로젝트 견고) 또는 단일콜(기본) ──────────────
  let spec, gv;
  if (chunked) {
    ({ spec, gv } = await genSpecChunked({ projectDir, project, context, ctxObj, corpus, readable, realFiles, resume }));
  } else {
    // 단일콜(기본): features 100행 ≈ 출력한도 근접 → 잘림 감지 + 재시도(간결화) 3회. 큰 프로젝트는 --chunked 권장.
    const specPrompt = readFileSync(join(SKILL_DIR, "prompt-spec.md"), "utf8")
      .replaceAll("{{PROJECT}}", project).replace("{{CONTEXT}}", context).replace("{{CORPUS}}", corpus);
    console.error("[s2] LLM 1/2 — spec.json (기능정의서, 행 단위, 단일콜)…");
    const r = await generateJson({
      basePrompt: specPrompt,
      saveRaw: (raw) => writeFileSync(join(projectDir, ".s2-spec-raw.txt"), raw),
      stamp: (o) => { o.project = project; },
      validate: (o) => validateSpec(o, { realFiles, readable, context: ctxObj }),
      attempts: 3,
      log: (m) => console.error(`[s2]   ${m}`),
    });
    spec = r.obj; gv = r.gv;
    for (const w of (gv.warnings || [])) console.error(`[s2][warn] ${w}`);
    if (!gv.ok) {
      if (spec) writeFileSync(join(projectDir, "spec.invalid.json"), JSON.stringify(spec, null, 2));
      console.error(`[s2] 가드 실패(${r.attempt}시도)${r.truncated ? " · 잘림 — 큰 프로젝트면 --chunked 로 대분류별 청크 생성 권장(§17)" : ""} → spec.invalid.json:`);
      for (const e of gv.errors) console.error("  - " + e);
      process.exit(1);
    }
  }

  spec._meta = stampMeta({ stage: "s2", inputCount: readable.length + 1, inputsFingerprint: fingerprint([context, corpus]) });

  // ── LLM 2/2: prd.md (프로즈, spec을 충실히 서술)
  const prdPrompt = readFileSync(join(SKILL_DIR, "prompt-prd.md"), "utf8")
    .replaceAll("{{PROJECT}}", project)
    .replace("{{SPEC}}", JSON.stringify(spec, null, 2))
    .replace("{{CONTEXT}}", context);
  console.error("[s2] LLM 2/2 — prd.md (내러티브 PRD)…");
  const prd = cleanMarkdownDoc(await callLLM(prdPrompt));
  if (prd.length < 300) console.error(`[s2][warn] prd.md가 짧음(${prd.length}자)`);

  // ── 세 산출물을 함께 기록(부분 기록으로 불일치 산출 방지 — 중간 실패 시 옛 세트 유지)
  writeFileSync(join(projectDir, "spec.json"), JSON.stringify(spec, null, 2));
  writeFileSync(join(projectDir, "prd.md"), prd + "\n");
  writeFileSync(join(projectDir, "features.md"), renderFeaturesMd(spec));

  const s = gv.stats;
  console.error(
    `[s2] OK → spec.json + features.md + prd.md  ` +
      `(기능 ${s.features}행[확정 ${s.confirmed}/제안 ${s.proposed}/미정 ${s.open}] · NFR ${s.nfr} · 규칙 ${s.businessRules} · 오픈이슈 ${s.openQuestions})`
  );

  const msg = `[${project}] s2 plan · 기능 ${s.features}행 · NFR ${s.nfr} · 규칙 ${s.businessRules} · 오픈이슈 ${s.openQuestions}`;
  const commit = commitRun(msg);
  console.error(commit.committed ? `[s2] git: 커밋됨 — ${msg}` : `[s2] git: skip (${commit.reason})`);
}

main().catch((e) => {
  console.error("[s2] ERROR:", e.message);
  process.exit(1);
});
