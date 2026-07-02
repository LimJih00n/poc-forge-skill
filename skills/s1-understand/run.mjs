// s1-understand · 내부 단계 오케스트레이션
// intake(코드) → 이해·정리(claude -p) → guard(코드) → write.
// 사용: node run.mjs <projectDir>       (기본: runs/gearloan)
//   projectDir/sources/* 를 읽어 projectDir/context.json + understanding.md 를 씀.
// LLM 스왑: 환경변수 POC_FORGE_LLM_CMD (기본 "claude -p").

import { readFileSync, readdirSync, writeFileSync, appendFileSync, statSync, existsSync, rmSync } from "node:fs";
import { join, resolve, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateContext, validateContextPlan, validateEnrichedAssets } from "./guard.mjs";
import { groupAssets, parseJsonlLines, doneGroupKeys, assembleAssets, assetsCoverage } from "./chunk.mjs";
import { fingerprint, stampMeta, commitRun } from "../../lib/version.mjs";
import { generateJson } from "../../lib/llm.mjs";

const SKILL_DIR = fileURLToPath(new URL(".", import.meta.url));
const TEXT_EXT = new Set([".md", ".txt", ".csv", ".tsv", ".json", ".log", ""]);

// 프로젝트 스코프 해석: 이름만 주면 poc-forge/runs/<name>, 경로 구분자 있으면 그 경로 그대로.
// (모든 스테이지 스킬 공통 규약 — 멀티 프로젝트를 위치 독립적으로 관리)
function resolveProjectDir(arg) {
  if (!arg) throw new Error("프로젝트를 지정하세요: node run.mjs <project|경로>  (예: node run.mjs gearloan)");
  if (arg.includes("/") || arg.includes("\\")) return resolve(arg);
  return resolve(SKILL_DIR, "..", "..", "runs", arg); // poc-forge/runs/<name>
}

// ── 1. intake (deterministic): sources/ 전부를 코퍼스+파일목록으로. truncate 없음.
//   readable(텍스트) = 본문을 코퍼스에 실음. binary(pdf/엑셀/이미지) = 목록만(뒤에서 자산 등재).
function readSources(sourcesDir) {
  const files = readdirSync(sourcesDir)
    .filter((f) => statSync(join(sourcesDir, f)).isFile())
    .sort();
  const readable = [];
  const binary = [];
  let corpus = "";
  for (const f of files) {
    if (TEXT_EXT.has(extname(f).toLowerCase())) {
      corpus += `\n\n===== FILE: ${f} =====\n${readFileSync(join(sourcesDir, f), "utf8")}\n`;
      readable.push(f);
    } else {
      binary.push(f);
    }
  }
  const manifest = [
    ...readable.map((f) => `- ${f} (readable)`),
    ...binary.map((f) => `- ${f} (binary)`),
  ].join("\n");
  return { corpus, manifest, files, readable, binary };
}

// ── 2. 이해·정리: 견고 JSON 생성 = 공용 lib/llm.mjs (callLLM + 잘림 감지 + 가드 피드백 재시도).

// ── understanding.md 를 context.json에서 결정적으로 렌더(사람/기계 쌍 = 항상 일치).
function renderUnderstanding(ctx) {
  const src = (a) => (a && a.length ? ` _(근거: ${a.join(", ")})_` : "");
  const L = [];
  L.push(`# 이해·정리 — ${ctx.project}`, "");
  L.push("> S1(understand) 산출. 소스 통일 정리본. 기계본 = `context.json`.", "");
  L.push("## 요약", "", ctx.summary, "");

  L.push("## 핵심 사실", "");
  for (const f of ctx.facts) L.push(`- **[${f.topic || "-"}]** ${f.claim}${src(f.sources)}`);
  L.push("");

  if (ctx.entities.length) {
    L.push("## 엔티티", "");
    for (const e of ctx.entities) L.push(`- **${e.name}**: ${(e.attributes || []).join(", ")}${src(e.sources)}`);
    L.push("");
  }
  if (ctx.glossary.length) {
    L.push("## 용어", "");
    for (const g of ctx.glossary) L.push(`- **${g.term}**: ${g.meaning}${src(g.sources)}`);
    L.push("");
  }

  const openContra = ctx.contradictions.filter((c) => c.status !== "resolved");
  const resolvedContra = ctx.contradictions.filter((c) => c.status === "resolved");
  L.push("## ⚠️ 모순 — 미해소 (해소 필요)", "");
  if (openContra.length)
    for (const c of openContra) {
      const pos = (c.positions || []).map((p) => `"${p.claim}" (${p.source || "?"})`).join(" ↔ ");
      L.push(`- **${c.topic}**: ${pos}${c.note ? ` — ${c.note}` : ""}`);
    }
  else L.push("_(미해소 모순 없음)_");
  L.push("");
  if (resolvedContra.length) {
    L.push("## ✅ 모순 — 해소됨", "");
    for (const c of resolvedContra) L.push(`- **${c.topic}**: ${c.resolution || "해소됨"}`);
    L.push("");
  }

  const openQ = ctx.openQuestions.filter((q) => q.status !== "answered");
  const answeredQ = ctx.openQuestions.filter((q) => q.status === "answered");
  L.push("## ❓ 오픈 질문 — 미해결 (확인 필요)", "");
  if (openQ.length)
    for (const q of openQ) L.push(`- ${q.item} — ${q.reason}${src(q.sources)}`);
  else L.push("_(미해결 질문 없음)_");
  L.push("");
  if (answeredQ.length) {
    L.push("## ✅ 오픈 질문 — 답변됨", "");
    for (const q of answeredQ) L.push(`- ${q.item} → **${q.answer || "답변됨"}**${src(q.sources)}`);
    L.push("");
  }

  if (ctx.scopeSignals.length) {
    L.push("## 범위 신호 (1차/2차 경계)", "");
    for (const s of ctx.scopeSignals) L.push(`- **[${s.phase}]** ${s.item}${src(s.sources)}`);
    L.push("");
  }

  L.push("## 제공 자산 (뒤 단계 재사용)", "");
  for (const a of ctx.assets || []) {
    const use = (a.useFor && a.useFor.length) ? ` · **useFor**: ${a.useFor.join(", ")}` : "";
    const rd = a.readable ? "" : " · _(binary·미추출)_";
    L.push(`- \`${a.file}\` — ${a.kind}${use}${rd}` + (a.summary ? `\n  - ${a.summary}` : ""));
  }
  L.push("");
  if (ctx._meta)
    L.push("---", "", `_생성: ${ctx._meta.generatedAt} · 소스 ${ctx._meta.inputCount}개 · 지문 \`${ctx._meta.inputsFingerprint}\`_`, "");
  return L.join("\n");
}

// ── --chunked: "skeleton-완결 → assets 배치별 상세화 + jsonl 체크포인트" (opt-in) ─────────
//   주의: context.json은 작아(~8K) 청크 적합도가 S2보다 낮다 → 지배적·결정적 배열 assets만 청크하고,
//   나머지(summary·facts·…)는 skeleton 한 콜에 완결. assets 아웃라인 = 파일목록에서 코드가 결정적 구성
//   (LLM이 파일을 드롭할 수 없음 → 커버리지 원천 보장). 상세화는 파일 배치 1:1 확장(assetsCoverage hard).
//   기존 단일콜 경로는 무손상 — 이 함수는 --chunked 일 때만 호출된다.
async function genContextChunked({ projectDir, project, files, readable, corpus, manifest, resume }) {
  const planPath = join(projectDir, ".s1-plan.json"); // 중간 산출(skeleton+아웃라인) — .s1- 접두라 gitignore
  const jsonlPath = join(projectDir, ".s1-assets.jsonl");
  const readableSet = new Set(readable);
  const outlineAssets = files.map((f) => ({ file: f, readable: readableSet.has(f) })); // 결정적 아웃라인(전 파일)

  // 1) skeleton (요약·사실·… 완결). assets 아웃라인은 코드가 stamp 로 주입. resume면 기존 plan 재사용.
  let plan;
  if (resume) {
    if (!existsSync(planPath)) throw new Error(`--resume 인데 .s1-plan.json 없음 — 먼저 fresh: node run.mjs ${project} --chunked`);
    plan = JSON.parse(readFileSync(planPath, "utf8"));
    console.error(`[s1] --chunked --resume: 기존 plan 재사용(facts ${plan.facts.length} · assets 아웃라인 ${plan.assets.length})`);
  } else {
    if (existsSync(jsonlPath)) rmSync(jsonlPath); // fresh = 이전 체크포인트 폐기(다른 plan)
    const planPrompt = readFileSync(join(SKILL_DIR, "prompt-plan.md"), "utf8")
      .replaceAll("{{PROJECT}}", project).replace("{{FILE_MANIFEST}}", manifest).replace("{{CORPUS}}", corpus);
    console.error("[s1] --chunked 1/2 — skeleton (요약·사실·엔티티·모순·오픈질문 완결)…");
    const rPlan = await generateJson({
      basePrompt: planPrompt,
      saveRaw: (raw) => writeFileSync(join(projectDir, ".s1-plan-raw.txt"), raw),
      stamp: (o) => { o.project = project; o.assets = outlineAssets; }, // 프로젝트명·assets 아웃라인 = 코드가 권위
      validate: (o) => validateContextPlan(o),
      attempts: 3,
      log: (m) => console.error(`[s1]   ${m}`),
    });
    if (!rPlan.gv.ok) {
      if (rPlan.obj) writeFileSync(join(projectDir, "context.plan.invalid.json"), JSON.stringify(rPlan.obj, null, 2));
      console.error(`[s1] skeleton 가드 실패(${rPlan.attempt}시도)${rPlan.truncated ? " · 잘림" : ""} → context.plan.invalid.json:`);
      for (const e of rPlan.gv.errors) console.error("  - " + e);
      process.exit(1);
    }
    plan = rPlan.obj;
    writeFileSync(planPath, JSON.stringify(plan, null, 2));
  }
  const groups = groupAssets(plan.assets);
  console.error(`[s1]   ✓ skeleton: facts ${plan.facts.length} · assets 아웃라인 ${plan.assets.length}개 · 배치 ${groups.length}`);

  // 2) assets 배치별 상세화 (jsonl append + resume: 완료 배치 skip)
  const already = existsSync(jsonlPath) ? parseJsonlLines(readFileSync(jsonlPath, "utf8")) : [];
  const done = doneGroupKeys(groups, already);
  if (done.size) console.error(`[s1]   체크포인트: 완료 배치 ${done.size}/${groups.length} skip`);
  const enrichTmpl = readFileSync(join(SKILL_DIR, "prompt-enrich.md"), "utf8");
  let gi = 0;
  for (const g of groups) {
    gi++;
    if (done.has(g.key)) continue;
    const outlineFiles = new Set(g.items.map((a) => a.file));
    const prompt = enrichTmpl
      .replaceAll("{{PROJECT}}", project)
      .replace("{{SUMMARY}}", plan.summary || "")
      .replace("{{FILE_MANIFEST}}", manifest)
      .replace("{{GROUP}}", JSON.stringify(g.items, null, 2))
      .replace("{{CORPUS}}", corpus);
    console.error(`[s1] --chunked 2/2 — 상세화 ${gi}/${groups.length}: ${g.key} (${g.items.length}파일)…`);
    const rEnr = await generateJson({
      basePrompt: prompt,
      saveRaw: (raw) => writeFileSync(join(projectDir, ".s1-enrich-raw.txt"), raw),
      validate: (o) => validateEnrichedAssets(o, { outlineFiles, label: g.key }),
      attempts: 3,
      log: (m) => console.error(`[s1]   ${m}`),
    });
    if (!rEnr.gv.ok) {
      writeFileSync(join(projectDir, "context.enrich.invalid.json"), JSON.stringify(rEnr.obj || {}, null, 2));
      console.error(`[s1] 상세화 가드 실패(${g.key}, ${rEnr.attempt}시도)${rEnr.truncated ? " · 잘림" : ""}:`);
      for (const e of rEnr.gv.errors) console.error("  - " + e);
      console.error(`  (완료분은 ${basename(jsonlPath)}에 보존 — 고친 뒤  node run.mjs ${project} --chunked --resume  로 이어서)`);
      process.exit(1);
    }
    appendFileSync(jsonlPath, rEnr.obj.assets.map((r) => JSON.stringify(r)).join("\n") + "\n");
    console.error(`[s1]   ✓ ${g.key}: ${rEnr.obj.assets.length}파일 append`);
  }

  // 3) 조립 + 전체 가드(validateContext, 근거·커버리지 재검증) + 커버리지 플로어(조용한 드롭 hard)
  const enriched = parseJsonlLines(readFileSync(jsonlPath, "utf8"));
  const assets = assembleAssets(plan.assets, enriched);
  // readable 은 결정적 아웃라인이 권위 — LLM 오분류 방지(코드가 파일목록에서 안다)
  const outlineReadable = new Map(plan.assets.map((a) => [a.file, a.readable]));
  for (const a of assets) if (outlineReadable.has(a.file)) a.readable = outlineReadable.get(a.file);
  const ctx = { ...plan, assets, project }; // plan.assets(아웃라인) → 상세화 assets 로 대체
  const gv = validateContext(ctx, files, { readable });
  for (const w of (gv.warnings || [])) console.error(`[s1][warn] ${w}`);
  const cov = assetsCoverage(plan.assets, assets);
  if (!gv.ok || !cov.ok) {
    writeFileSync(join(projectDir, "context.invalid.json"), JSON.stringify(ctx, null, 2));
    console.error("[s1] 조립 가드 실패 → context.invalid.json:");
    for (const e of [...(gv.ok ? [] : gv.errors), ...cov.errors]) console.error("  - " + e);
    console.error(`  (체크포인트 ${basename(jsonlPath)} 유지 — 원인 수정 후  --chunked --resume  재실행)`);
    process.exit(1);
  }
  console.error(`[s1]   ✓ 조립: assets ${assets.length}개 (아웃라인 ${cov.planCount} 전부 커버) · 배치 ${groups.length}`);
  return { ctx, gv };
}

async function main() {
  const args = process.argv.slice(2);
  const projectArg = args.find((a) => !a.startsWith("-"));
  const chunked = args.includes("--chunked");
  const resume = args.includes("--resume");
  const projectDir = resolveProjectDir(projectArg);
  const sourcesDir = join(projectDir, "sources");
  const project = basename(projectDir);

  const { corpus, manifest, files, readable, binary } = readSources(sourcesDir);
  if (!files.length) throw new Error(`sources/ 에 파일이 없음: ${sourcesDir}`);
  console.error(
    `[s1] intake: 파일 ${files.length}개 (readable ${readable.length} / binary ${binary.length})` +
      (binary.length ? ` | binary(목록만): ${binary.join(", ")}` : "")
  );

  // ── context.json 생성: --chunked(assets 배치 상세화, 체크포인트) 또는 단일콜(기본) ──────────────
  let ctx, gv;
  if (chunked) {
    ({ ctx, gv } = await genContextChunked({ projectDir, project, files, readable, corpus, manifest, resume }));
  } else {
    const prompt = readFileSync(join(SKILL_DIR, "prompt.md"), "utf8")
      .replaceAll("{{PROJECT}}", project)
      .replace("{{FILE_MANIFEST}}", manifest)
      .replace("{{CORPUS}}", corpus);

    console.error("[s1] LLM 호출 중… (claude -p, 1~3분 소요 가능)");
    const r = await generateJson({
      basePrompt: prompt,
      saveRaw: (raw) => writeFileSync(join(projectDir, ".s1-llm-raw.txt"), raw), // 디버그용 원본(각 시도)
      stamp: (o) => { o.project = project; }, // 프로젝트명은 코드가 권위 있게 확정
      validate: (o) => validateContext(o, files, { readable }),
      attempts: 2,
      log: (m) => console.error(`[s1]   ${m}`),
    });
    ctx = r.obj; gv = r.gv;
    for (const w of (gv.warnings || [])) console.error(`[s1][warn] ${w}`);
    if (!gv.ok) {
      if (ctx) writeFileSync(join(projectDir, "context.invalid.json"), JSON.stringify(ctx, null, 2));
      console.error(`[s1] 가드 실패(${r.attempt}시도)${r.truncated ? " · 잘림 감지 — 큰 프로젝트면 --chunked 로 assets 청크 생성 권장" : ""} → context.invalid.json 로 덤프:`);
      for (const e of gv.errors) console.error("  - " + e);
      process.exit(1);
    }
  }
  const stats = gv.stats;

  // 버전 도장: 소스 지문 → 상류 변경 감지(stale 추적 기초).
  ctx._meta = stampMeta({
    stage: "s1",
    inputCount: files.length,
    inputsFingerprint: fingerprint([manifest, corpus]),
  });

  writeFileSync(join(projectDir, "context.json"), JSON.stringify(ctx, null, 2));
  writeFileSync(join(projectDir, "understanding.md"), renderUnderstanding(ctx));
  console.error(
    `[s1] OK → context.json + understanding.md  ` +
      `(facts ${stats.facts} · 모순 ${stats.contradictions}[해소 ${stats.contradictionsResolved}] · ` +
      `질문 ${stats.openQuestions}[답변 ${stats.openQuestionsAnswered}] · 자산 ${stats.assets} · 커버리지 ${stats.coverage})`
  );

  // 이력: best-effort git 커밋 (repo면 커밋, 아니면 skip).
  const openC = stats.contradictions - stats.contradictionsResolved;
  const openQn = stats.openQuestions - stats.openQuestionsAnswered;
  const msg = `[${project}] s1 understand · 소스 ${files.length} · 미해소 모순 ${openC} · 미해결 질문 ${openQn}`;
  const commit = commitRun(msg);
  console.error(commit.committed ? `[s1] git: 커밋됨 — ${msg}` : `[s1] git: skip (${commit.reason})`);
}

main().catch((e) => {
  console.error("[s1] ERROR:", e.message);
  process.exit(1);
});
