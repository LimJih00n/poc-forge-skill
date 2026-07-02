// s3-design · 내부 단계 오케스트레이션 (★가장 무거움 · 2 페이즈 + 내부 화면 게이트 + 화면 역산)
//   IN : runs/<p>/{context.json,understanding.md,spec.json,features.md,prd.md} + sources/ (S1·S2 전부 + 원자료)
//   phase ui     : claude → page-spec.json + page-spec.md + (fal) screens/*.png  → ✋게이트("이 화면이면 돼요?")
//   phase design : (승인된 page-spec 역산) claude×4 → schema.json · server-spec.json · acceptance.json · dev-doc.md
//   흐름은 완전 순차 + 화면 역산(DB·서버·test는 spec이 아니라 *승인된 화면*을 역산).
//   사용: node run.mjs <project> --phase=ui [--no-images]      그다음 화면 확인 후:  node run.mjs <project> --phase=design
//   LLM 스왑: POC_FORGE_LLM_CMD

import { readFileSync, readdirSync, writeFileSync, appendFileSync, statSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validatePageSpec, validateSchema, validateServerSpec, validateAcceptance, validateRuleCoverage,
  validatePageSpecPlan, validatePageSpecEnrichedGroup, validateSchemaPlan, validateSchemaEnrichedGroup,
  validateServerSpecPlan, validateServerSpecEnrichedGroup, validateAcceptancePlan, validateAcceptanceEnrichedGroup,
} from "./guard.mjs";
import { pageSpecChunk, schemaChunk, serverChunk, acceptanceChunk, parseJsonlLines } from "./chunk.mjs";
import { fingerprint, stampMeta, commitRun, POC_FORGE_ROOT, stalenessWarnings } from "../../lib/version.mjs";
import { cleanMarkdownDoc } from "../../lib/clean.mjs";
import { callLLM, generateJson } from "../../lib/llm.mjs";

const SKILL_DIR = fileURLToPath(new URL(".", import.meta.url));
const TEXT_EXT = new Set([".md", ".txt", ".csv", ".tsv", ".json", ".log", ""]);

function resolveProjectDir(arg) {
  if (!arg) throw new Error("프로젝트를 지정하세요: node run.mjs <project> --phase=ui|design");
  if (arg.includes("/") || arg.includes("\\")) return resolve(arg);
  return resolve(SKILL_DIR, "..", "..", "runs", arg);
}

function readIf(p) { return existsSync(p) ? readFileSync(p, "utf8") : ""; }

// 원자료(readable) 코퍼스 — 원칙#1: 전량 주입(truncate 없음). CSV 등 실데이터가 schema 역산 근거.
function readReadableCorpus(sourcesDir) {
  if (!existsSync(sourcesDir)) return "";
  let corpus = "";
  for (const f of readdirSync(sourcesDir).filter((x) => statSync(join(sourcesDir, x)).isFile()).sort()) {
    if (!TEXT_EXT.has(extname(f).toLowerCase())) continue;
    corpus += `\n\n===== FILE: ${f} =====\n${readFileSync(join(sourcesDir, f), "utf8")}\n`;
  }
  return corpus;
}

// S1·S2 전부 + 원자료 로드 (누적 맥락: 직전만이 아니라 이전 전부를 본다)
function loadUpstream(projectDir) {
  const contextPath = join(projectDir, "context.json");
  const specPath = join(projectDir, "spec.json");
  if (!existsSync(contextPath)) throw new Error(`context.json 없음 — 먼저 S1 실행: node skills/s1-understand/run.mjs ${basename(projectDir)}`);
  if (!existsSync(specPath)) throw new Error(`spec.json 없음 — 먼저 S2 실행: node skills/s2-plan/run.mjs ${basename(projectDir)}`);
  const context = readFileSync(contextPath, "utf8");
  return {
    context,
    ctxObj: JSON.parse(context),
    understanding: readIf(join(projectDir, "understanding.md")),
    spec: readFileSync(specPath, "utf8"),
    specObj: JSON.parse(readFileSync(specPath, "utf8")),
    prd: readIf(join(projectDir, "prd.md")),
    corpus: readReadableCorpus(join(projectDir, "sources")),
    realFiles: (JSON.parse(context).assets || []).map((a) => a.file),
  };
}

// LLM 호출(callLLM) + 견고 JSON 생성(generateJson, 잘림 감지+가드 피드백 재시도) + 산문 정리 = 공용 lib.
//   (JSON 추출 시 산문 프리앰블/꼬리말 오염·`{` preamble 취약 근절도 lib/clean.mjs 로 단일화)

function fillPrompt(file, vars) {
  let t = readFileSync(join(SKILL_DIR, file), "utf8");
  for (const [k, v] of Object.entries(vars)) t = t.replaceAll(`{{${k}}}`, v);
  return t;
}

// ── gpt2 공통 디자인 프리픽스 (spec에서 도메인 불가지하게 도출 → 화면 세트 일관성) ─────────
function designToneFromSpec(specObj) {
  const brand = specObj?.product?.name || specObj?.project || "서비스";
  const hay = [
    ...(specObj.features || []).map((f) => `${f.기능 || ""} ${f.상세내용 || ""}`),
    ...(specObj.nfr || []).map((n) => n.requirement || ""),
  ];
  const themeHit = hay.find((t) => /CI|테마|팔레트|색상|컬러|파랑|블루|blue|브랜드톤/i.test(t)) || "";
  return { brand, theme: themeHit.trim() };
}
// knowledge/design-system/tokens.md 의 "프롬프트 주입용 압축 블록"(팔레트·라운드·그림자·타이포·간격·컴포넌트 언어)
//   을 읽어 미감 규율을 주입(§11 개선). accent(브랜드색)만 spec에서 도출해 치환, 나머지 스케일/리듬/그림자/타이포는 고정.
//   파일 없거나 파싱 실패 시 빈 문자열(폴백 = 기존 최소 톤). 도메인 불가지.
function loadDesignSystemBlock(specObj) {
  const { theme } = designToneFromSpec(specObj);
  let block = "";
  try {
    const md = readFileSync(join(POC_FORGE_ROOT, "knowledge", "design-system", "tokens.md"), "utf8");
    const m = md.match(/주입용[\s\S]*?```([\s\S]*?)```/); // "▶ 프롬프트 주입용 …" 뒤 첫 코드펜스
    if (m) block = m[1].trim();
  } catch { /* 디자인시스템 없음 → 폴백 */ }
  if (!block) return "";
  const accent = theme ? `프로젝트 브랜드색(${theme})` : "#2779eb (정갈한 SaaS 블루)";
  return block.replaceAll("{{ACCENT|#2779eb}}", accent);
}
function commonImagePrefix(specObj) {
  const { brand, theme } = designToneFromSpec(specObj);
  const ds = loadDesignSystemBlock(specObj);
  return [
    "디자이너가 완성한 피그마 UI 목업 시안처럼, '이렇게 만들 겁니다'라고 고객에게 보여줄 목적의 화면 한 장을 생성해줘.",
    `서비스명(가칭) = "${brand}". 데스크톱 웹앱 풀페이지 스크린샷, 가로(landscape).`,
    theme ? `브랜드/테마 톤: ${theme}` : "일관된 브랜드 톤(각 화면 지정을 따름).",
    ds || "모든 화면이 같은 앱으로 보이도록 헤더/네비/팔레트/컴포넌트 비례를 통일. 깔끔한 배경, 라운드 카드.",
    "화면 성격에 맞게: 관리자/운영 화면은 표·필터·상태 배지·조작 버튼을 또렷하게, 소비자 화면은 첫 화면 CTA·카드 비율·정보 밀도를 우선.",
    "한글 타이포를 또렷하고 정확하게 렌더. 실재하는 로고·회사명·명품 브랜드 상표/모노그램/트레이드마크 금지(무브랜드 더미 콘텐츠). 로렘입숨 금지 — 실제처럼 한국어 콘텐츠로 채울 것.",
    "",
    "[이 화면]",
  ].join("\n");
}

// ── fal 렌더러 ────────────────────────────────────────────────────────────────
function loadFalKey() {
  if (process.env.FAL_KEY) return process.env.FAL_KEY;
  const envPath = resolve(POC_FORGE_ROOT, "..", "..", ".env"); // poc-forge/../../.env = bigshift/.env
  if (existsSync(envPath))
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*FAL_KEY\s*=\s*(.*)\s*$/);
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    }
  return "";
}
async function falRender(falKey, prompt, outPath) {
  const r = await fetch("https://fal.run/openai/gpt-image-2", {
    method: "POST",
    headers: { Authorization: "Key " + falKey, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, image_size: "landscape_16_9", num_images: 1, quality: "high", output_format: "png" }),
  });
  if (!r.ok) throw new Error(`fal ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const url = j?.images?.[0]?.url;
  if (!url) throw new Error("fal 응답에 images[0].url 없음");
  const img = await fetch(url);
  const buf = Buffer.from(await img.arrayBuffer());
  writeFileSync(outPath, buf);
  return buf.length;
}
// 동시성 제한 풀
async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let idx = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (idx < items.length) {
        const i = idx++;
        try { results[i] = await worker(items[i], i); }
        catch (e) { results[i] = { error: String(e.message || e) }; }
      }
    })
  );
  return results;
}

// ── 렌더: page-spec.md (사람용 게이트 리뷰) ────────────────────────────────────
function renderPageSpecMd(ps) {
  const cell = (v) => (Array.isArray(v) ? v.join(", ") : v ?? "").toString().replace(/\|/g, " /").replace(/\n+/g, " ").trim();
  const L = [];
  L.push(`# 화면 설계 (page-spec) — ${ps.project}`, "");
  L.push("> S3(design) phase ui 산출 · 기계본 = `page-spec.json` · 목업 = `screens/*.png`. 게이트: **이 화면이면 돼요?**", "");
  if (ps.ia?.length) {
    L.push("## IA (전역 내비게이션)", "");
    for (const sec of ps.ia) {
      L.push(`- **${cell(sec.section)}**`);
      for (const it of sec.items || []) L.push(`  - ${cell(it.label)} \`${cell(it.url)}\` _(${cell(it.roles)})_`);
    }
    L.push("");
  }
  if (ps.flows?.length) {
    L.push("## 사용자 플로우 (여정) — UX", "");
    for (const fl of ps.flows) {
      L.push(`### ${cell(fl.name)}${fl.scenario ? ` _(${cell(fl.scenario)})_` : ""}`, "");
      if (fl.actor) L.push(`- 액터: ${cell(fl.actor)}`);
      for (const s of fl.steps || []) L.push(`  - \`${cell(s.page)}\` — ${cell(s.action)} → \`${cell(s.to) || "—"}\``);
      L.push("");
    }
  }
  L.push("## 화면 목록", "");
  L.push("| id | 화면 | URL | 권한 | 기능 | 상태 | 목업 |");
  L.push("|---|---|---|---|---|---|---|");
  for (const p of ps.pages)
    L.push(`| ${cell(p.id)} | ${cell(p.name)} | \`${cell(p.url)}\` | ${cell(p.roles)} | ${cell(p.features)} | ${cell(p.states)} | ${p.renderScreen ? "○" : "-"} |`);
  L.push("");
  for (const p of ps.pages) {
    L.push(`### ${cell(p.name)} (\`${cell(p.url)}\`)`, "");
    if (p.purpose) L.push(`- 목적: ${cell(p.purpose)}`);
    if (p.layout) L.push(`- 레이아웃: ${cell(p.layout)}`);
    if (p.components?.length) L.push(`- 컴포넌트: ${p.components.map((c) => cell(c.name)).join(", ")}`);
    if (p.fields?.length) L.push(`- 필드: ${p.fields.map((f) => `${cell(f.name)}(${cell(f.why)})`).join(", ")}`);
    if (p.actions?.length) L.push(`- 액션: ${p.actions.map((a) => `${cell(a.label)}${a.mutates ? "*" : ""}`).join(", ")}`);
    if (p.media_refs?.length) L.push(`- 참조데이터: ${cell(p.media_refs)}`);
    L.push("");
  }
  if (ps._meta) L.push("---", "", `_생성: ${ps._meta.generatedAt} · 화면 ${ps.pages.length} · 지문 \`${ps._meta.inputsFingerprint}\`_`, "");
  return L.join("\n");
}

// ══ --chunked: "아웃라인-완결 → 그룹별 상세화 + jsonl 체크포인트" (S2 genSpecChunked 미러) ══════
//   S3 4개 산출(page-spec/schema/server/acceptance)의 지배적 배열을 청크. 진짜 위험=커버리지 후퇴를
//   plan(아웃라인)이 한 응집 콜로 전체 목록·커버리지를 고정하고, enrich가 1:1 확장, coverage가 조용한 드롭 hard 차단.
//   opt-in: --chunked 일 때만. 중간 사망은 --chunked --resume(기존 .s3-<x>-plan.json 재사용 + 완료 그룹 skip).
//
// 범용 엔진: chunk(어댑터 번들) + plan/enrich 프롬프트·가드 + 조립본 전체 가드를 받아 {obj, gv}(가드 통과) 반환.
//   실패 시 invalid.json 저장 + 로그 + process.exit(1). sidecar = 배열 밖 누적물(acceptance selectors)용 선택 훅.
async function genChunkedStage(o) {
  const {
    projectDir, project, tag, resume, chunk,
    planPrompt, validatePlan, enrichPrompt, validateGroup, buildObj, validateWhole, sidecar,
  } = o;
  const log = (m) => console.error(`[s3:design]   ${m}`);
  const planPath = join(projectDir, `.s3-${tag}-plan.json`);
  const jsonlPath = join(projectDir, `.s3-${tag}.jsonl`);
  const sidePath = join(projectDir, `.s3-${tag}-side.json`);

  // 1) plan (아웃라인-완결). resume 면 기존 plan 재사용(같은 체크포인트를 이어야 하므로 재생성 안 함).
  let plan;
  if (resume) {
    if (!existsSync(planPath)) throw new Error(`--chunked --resume 인데 ${basename(planPath)} 없음 — 먼저 fresh: --phase=... --chunked`);
    plan = JSON.parse(readFileSync(planPath, "utf8"));
    console.error(`[s3:design] ${tag} --chunked --resume: 기존 plan 재사용(${(plan[chunk.arrayKey] || []).length} ${chunk.arrayKey})`);
  } else {
    if (existsSync(jsonlPath)) rmSync(jsonlPath);   // fresh = 이전 체크포인트 폐기(다른 plan)
    if (existsSync(sidePath)) rmSync(sidePath);
    console.error(`[s3:design] ${tag} --chunked 1/2 — plan (아웃라인-완결, 목록·커버리지 고정)…`);
    const rPlan = await generateJson({
      basePrompt: planPrompt,
      saveRaw: (raw) => writeFileSync(join(projectDir, `.s3-${tag}-plan-raw.txt`), raw),
      stamp: (obj) => { obj.project = project; },
      validate: validatePlan,
      attempts: 3,
      log,
    });
    if (!rPlan.gv.ok) {
      if (rPlan.obj) writeFileSync(join(projectDir, `${tag}.plan.invalid.json`), JSON.stringify(rPlan.obj, null, 2));
      console.error(`[s3:design] ${tag} plan 가드 실패(${rPlan.attempt}시도)${rPlan.truncated ? " · 잘림" : ""} → ${tag}.plan.invalid.json:`);
      for (const e of rPlan.gv.errors) console.error("  - " + e);
      process.exit(1);
    }
    plan = rPlan.obj;
    writeFileSync(planPath, JSON.stringify(plan, null, 2));
  }
  const planArray = plan[chunk.arrayKey] || [];
  const groups = chunk.group(planArray);
  console.error(`[s3:design]   ✓ ${tag} plan: ${planArray.length} ${chunk.arrayKey} · 그룹 ${groups.length}`);

  // 2) 그룹별 상세화 (jsonl append + resume: 완료 그룹 skip)
  const already = existsSync(jsonlPath) ? parseJsonlLines(readFileSync(jsonlPath, "utf8")) : [];
  const done = chunk.done(groups, already);
  if (done.size) console.error(`[s3:design]   체크포인트: 완료 그룹 ${done.size}/${groups.length} skip`);
  let side = existsSync(sidePath) ? JSON.parse(readFileSync(sidePath, "utf8")) : {};
  let gi = 0;
  for (const g of groups) {
    gi++;
    if (done.has(g.key)) continue;
    const outlineIds = new Set(g.items.map(chunk.idFn));
    console.error(`[s3:design] ${tag} --chunked 2/2 — 상세화 ${gi}/${groups.length}: ${g.label} (${g.items.length})…`);
    const rEnr = await generateJson({
      basePrompt: enrichPrompt(g, plan),
      saveRaw: (raw) => writeFileSync(join(projectDir, `.s3-${tag}-enrich-raw.txt`), raw),
      validate: (obj) => validateGroup(obj, { outlineIds, label: g.label }),
      attempts: 3,
      log,
    });
    if (!rEnr.gv.ok) {
      writeFileSync(join(projectDir, `${tag}.enrich.invalid.json`), JSON.stringify(rEnr.obj || {}, null, 2));
      console.error(`[s3:design] ${tag} 상세화 가드 실패(${g.label}, ${rEnr.attempt}시도)${rEnr.truncated ? " · 잘림" : ""}:`);
      for (const e of rEnr.gv.errors) console.error("  - " + e);
      console.error(`  (완료분은 ${basename(jsonlPath)}에 보존 — 고친 뒤  --phase=... --chunked --resume  로 이어서)`);
      process.exit(1);
    }
    const rows = (rEnr.obj[chunk.arrayKey] || []).map((r) => ({ _group: g.key, ...r }));
    appendFileSync(jsonlPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    if (sidecar) { side = sidecar(side, rEnr.obj); writeFileSync(sidePath, JSON.stringify(side, null, 2)); }
    console.error(`[s3:design]   ✓ ${g.label}: ${rows.length} append`);
  }

  // 3) 조립 + 전체 가드 + 커버리지 플로어(조용한 드롭 hard)
  const enriched = parseJsonlLines(readFileSync(jsonlPath, "utf8"));
  const assembledArray = chunk.assemble(planArray, enriched);
  const obj = buildObj(plan, assembledArray, side);
  const gv = validateWhole(obj);
  for (const w of (gv.warnings || [])) console.error(`[s3:design][warn] ${w}`);
  const cov = chunk.coverage(planArray, assembledArray);
  if (!gv.ok || !cov.ok) {
    writeFileSync(join(projectDir, `${tag}.invalid.json`), JSON.stringify(obj, null, 2));
    console.error(`[s3:design] ${tag} 조립 가드 실패 → ${tag}.invalid.json:`);
    for (const e of [...(gv.ok ? [] : gv.errors), ...cov.errors]) console.error("  - " + e);
    console.error(`  (체크포인트 ${basename(jsonlPath)} 유지 — 원인 수정 후  --chunked --resume  재실행)`);
    process.exit(1);
  }
  console.error(`[s3:design]   ✓ ${tag} 조립: ${assembledArray.length} ${chunk.arrayKey} (plan ${cov.planCount} 전부 커버)`);
  return { obj, gv };
}

// ── 4개 산출별 청크 어댑터(얇은 배선) — 각각 {obj, gv} 반환(가드 통과), 실패 시 내부에서 exit ───────
function genPageSpecChunked({ projectDir, project, up, resume }) {
  return genChunkedStage({
    projectDir, project, tag: "page-spec", resume, chunk: pageSpecChunk,
    planPrompt: fillPrompt("prompt-page-spec-plan.md", {
      PROJECT: project, CONTEXT: up.context, UNDERSTANDING: up.understanding, SPEC: up.spec, PRD: up.prd, CORPUS: up.corpus,
    }),
    validatePlan: (o) => validatePageSpecPlan(o, { spec: up.specObj }),
    enrichPrompt: (g, plan) => fillPrompt("prompt-page-spec-enrich.md", {
      PROJECT: project, GROUP: JSON.stringify(g.items, null, 2), IA: JSON.stringify(plan.ia || [], null, 2),
      CONTEXT: up.context, SPEC: up.spec, PRD: up.prd, CORPUS: up.corpus,
    }),
    validateGroup: (o, ctx) => validatePageSpecEnrichedGroup(o, ctx),
    buildObj: (plan, pages) => ({ ...plan, pages, project }),
    validateWhole: (o) => validatePageSpec(o, { spec: up.specObj, realFiles: up.realFiles }),
  });
}

function genSchemaChunked({ projectDir, project, up, pageSpec, resume }) {
  return genChunkedStage({
    projectDir, project, tag: "schema", resume, chunk: schemaChunk,
    planPrompt: fillPrompt("prompt-schema-plan.md", { PROJECT: project, PAGE_SPEC: pageSpec, SPEC: up.spec, CONTEXT: up.context, CORPUS: up.corpus }),
    validatePlan: (o) => validateSchemaPlan(o),
    enrichPrompt: (g, plan) => fillPrompt("prompt-schema-enrich.md", {
      PROJECT: project, GROUP: JSON.stringify(g.items, null, 2),
      SCHEMA_OUTLINE: JSON.stringify({ tables: (plan.tables || []).map((t) => ({ name: t.name, purpose: t.purpose })), relations: plan.relations || [] }, null, 2),
      PAGE_SPEC: pageSpec, SPEC: up.spec, CORPUS: up.corpus,
    }),
    validateGroup: (o, ctx) => validateSchemaEnrichedGroup(o, ctx),
    buildObj: (plan, tables) => ({ ...plan, tables, project }),
    validateWhole: (o) => validateSchema(o),
  });
}

function genServerChunked({ projectDir, project, up, pageSpec, pageSpecObj, schemaStr, tableNames, resume }) {
  return genChunkedStage({
    projectDir, project, tag: "server", resume, chunk: serverChunk,
    planPrompt: fillPrompt("prompt-server-plan.md", { PROJECT: project, PAGE_SPEC: pageSpec, SCHEMA: schemaStr, SPEC: up.spec }),
    validatePlan: (o) => validateServerSpecPlan(o, { spec: up.specObj, tableNames }),
    enrichPrompt: (g, plan) => fillPrompt("prompt-server-enrich.md", {
      PROJECT: project, GROUP: JSON.stringify(g.items, null, 2), MODULES: JSON.stringify(plan.modules || [], null, 2),
      PAGE_SPEC: pageSpec, SCHEMA: schemaStr, SPEC: up.spec,
    }),
    validateGroup: (o, ctx) => validateServerSpecEnrichedGroup(o, ctx),
    buildObj: (plan, endpoints) => ({ ...plan, endpoints, project }),
    validateWhole: (o) => validateServerSpec(o, { spec: up.specObj, tableNames, pageSpec: pageSpecObj }),
  });
}

function genAcceptanceChunked({ projectDir, project, up, pageSpec, pageSpecObj, serverStr, server, resume }) {
  return genChunkedStage({
    projectDir, project, tag: "acceptance", resume, chunk: acceptanceChunk,
    planPrompt: fillPrompt("prompt-acceptance-plan.md", { PROJECT: project, PAGE_SPEC: pageSpec, SERVER_SPEC: serverStr, SPEC: up.spec }),
    validatePlan: (o) => validateAcceptancePlan(o, { spec: up.specObj, pageSpec: pageSpecObj }),
    enrichPrompt: (g, plan) => fillPrompt("prompt-acceptance-enrich.md", {
      PROJECT: project, GROUP: JSON.stringify(g.items, null, 2), PAGE_SPEC: pageSpec, SERVER_SPEC: serverStr, SPEC: up.spec,
    }),
    validateGroup: (o, ctx) => validateAcceptanceEnrichedGroup(o, ctx),
    // 배열 밖 누적물 = selectors(각 enrich가 자기 그룹 것 반환 → 병합)
    sidecar: (side, enrichObj) => ({ selectors: { ...(side.selectors || {}), ...(enrichObj.selectors || {}) } }),
    buildObj: (plan, tests, side) => ({ ...plan, selectors: side.selectors || {}, tests, project }),
    validateWhole: (o) => validateAcceptance(o, { spec: up.specObj, pageSpec: pageSpecObj, serverSpec: server }),
  });
}

// ── PHASE UI ──────────────────────────────────────────────────────────────────
async function phaseUi(projectDir, project, up, { noImages, imagesOnly, chunked, resume }) {
  const psPath = join(projectDir, "page-spec.json");
  let ps, gv;
  if (imagesOnly) {
    // 설계-먼저: 기존(승인된) page-spec 재사용 → 이미지만 렌더(claude 재호출 없음 = 설계 안 바뀜)
    if (!existsSync(psPath)) throw new Error(`page-spec.json 없음 — 먼저 설계 생성: node run.mjs ${project} --phase=ui`);
    ps = JSON.parse(readFileSync(psPath, "utf8"));
    gv = validatePageSpec(ps, { spec: up.specObj, realFiles: up.realFiles });
    if (!gv.ok) { console.error("[s3:ui] 기존 page-spec 가드 실패:"); for (const e of gv.errors) console.error("  - " + e); process.exit(1); }
    console.error("[s3:ui] --images-only: 기존 page-spec.json 재사용(claude 호출 생략) → 렌더만");
  } else if (chunked) {
    // 청크: 아웃라인(전체 화면 목록·커버리지 고정) → 섹션별 상세화. genPageSpecChunked가 조립+가드까지(실패 시 내부 exit).
    console.error(`[s3:ui] --chunked${resume ? " --resume" : ""}: page-spec 청크 생성(아웃라인 → 섹션별 상세화)…`);
    ({ obj: ps, gv } = await genPageSpecChunked({ projectDir, project, up, resume }));
    ps._meta = stampMeta({ stage: "s3-ui", inputCount: up.realFiles.length + 2, inputsFingerprint: fingerprint([up.context, up.spec]) });
    writeFileSync(psPath, JSON.stringify(ps, null, 2));
    writeFileSync(join(projectDir, "page-spec.md"), renderPageSpecMd(ps));
  } else {
    const prompt = fillPrompt("prompt-page-spec.md", {
      PROJECT: project, CONTEXT: up.context, UNDERSTANDING: up.understanding, SPEC: up.spec, PRD: up.prd, CORPUS: up.corpus,
    });
    console.error("[s3:ui] LLM — page-spec.json (화면 설계)…");
    const r = await generateJson({
      basePrompt: prompt,
      saveRaw: (raw) => writeFileSync(join(projectDir, ".s3-pagespec-raw.txt"), raw),
      stamp: (o) => { o.project = project; },
      validate: (o) => validatePageSpec(o, { spec: up.specObj, realFiles: up.realFiles }),
      attempts: 2,
      log: (m) => console.error(`[s3:ui]   ${m}`),
    });
    ps = r.obj; gv = r.gv;
    for (const w of (gv.warnings || [])) console.error(`[s3:ui][warn] ${w}`);
    if (!gv.ok) {
      if (ps) writeFileSync(join(projectDir, "page-spec.invalid.json"), JSON.stringify(ps, null, 2));
      console.error(`[s3:ui] 가드 실패(${r.attempt}시도)${r.truncated ? " · 잘림 감지" : ""} → page-spec.invalid.json:`);
      for (const e of gv.errors) console.error("  - " + e);
      process.exit(1);
    }

    ps._meta = stampMeta({ stage: "s3-ui", inputCount: up.realFiles.length + 2, inputsFingerprint: fingerprint([up.context, up.spec]) });
    writeFileSync(psPath, JSON.stringify(ps, null, 2));
    writeFileSync(join(projectDir, "page-spec.md"), renderPageSpecMd(ps));
  }

  // fal 렌더 (전 화면: renderScreen=true). 재도출 모델 → 기존 png 정리 후 새로 생성.
  const screensDir = join(projectDir, "screens");
  mkdirSync(screensDir, { recursive: true });
  const toRender = ps.pages.filter((p) => p.renderScreen === true && typeof p.gpt2Prompt === "string" && p.gpt2Prompt.trim());
  let rendered = 0, imgFail = 0;
  if (noImages) {
    console.error(`[s3:ui] --no-images: gpt2 렌더 건너뜀 (렌더 대상 ${toRender.length}개)`);
  } else {
    const falKey = loadFalKey();
    if (!falKey) {
      console.error("[s3:ui][warn] FAL_KEY 없음 → 목업 미생성 (bigshift/.env 확인). page-spec은 생성됨.");
    } else {
      for (const f of readdirSync(screensDir)) if (f.toLowerCase().endsWith(".png")) rmSync(join(screensDir, f)); // stale 정리
      const prefix = commonImagePrefix(up.specObj);
      console.error(`[s3:ui] gpt2 렌더 — 전 화면 ${toRender.length}개 (동시 3)…`);
      const res = await runPool(toRender, 3, async (p) => {
        const size = await falRender(falKey, `${prefix}\n${p.gpt2Prompt}`, join(screensDir, `${p.id}.png`));
        console.error(`[s3:ui]   ✓ ${p.id}.png (${Math.round(size / 1024)}KB)`);
        return size;
      });
      res.forEach((r, i) => { if (r && r.error) { imgFail++; console.error(`[s3:ui]   ✗ ${toRender[i].id}: ${r.error}`); } else rendered++; });
    }
  }

  const s = gv.stats;
  const msg = `[${project}] s3 design (ui) · 화면 ${s.pages}(렌더대상 ${s.renderScreens}) · 플로우 ${s.flows} · 기능커버 ${s.coveredFeatures}/${s.confirmed}`;
  const commit = commitRun(msg);
  console.error(`[s3:ui] OK → page-spec.json + page-spec.md${rendered ? ` + screens/*.png ×${rendered}` : ""}${imgFail ? ` (실패 ${imgFail})` : ""}`);
  console.error(commit.committed ? `[s3:ui] git: 커밋됨 — ${msg}` : `[s3:ui] git: skip (${commit.reason})`);
  console.error("");
  console.error("✋ 화면 게이트: screens/ + page-spec.md 를 확인하세요 — '이 화면이면 돼요?'");
  if (noImages) console.error(`   설계 유지하고 이미지만 렌더: node skills/s3-design/run.mjs ${project} --phase=ui --images-only`);
  console.error(`   승인되면 역산 진행:  node skills/s3-design/run.mjs ${project} --phase=design`);
  console.error(`   화면 수정 필요하면:  page-spec 조정 후  node skills/s3-design/run.mjs ${project} --phase=ui  (전체 재도출)`);
}

// ── PHASE DESIGN (역산) ────────────────────────────────────────────────────────
async function phaseDesign(projectDir, project, up, { chunked, resume }) {
  const pagePath = join(projectDir, "page-spec.json");
  if (!existsSync(pagePath)) throw new Error(`page-spec.json 없음 — 먼저 phase ui 실행: node skills/s3-design/run.mjs ${project} --phase=ui`);
  const pageSpec = readFileSync(pagePath, "utf8");
  const pageSpecObj = JSON.parse(pageSpec); // 가드용(mutates 커버리지 등)
  const fp = (extra) => fingerprint([up.spec, pageSpec, extra]);

  // 1/4 schema.json (화면 역산 → DB)  ·  --chunked: 테이블 배치별 청크(아웃라인 → 배치 상세화)
  let schema, gv;
  if (chunked) {
    ({ obj: schema, gv } = await genSchemaChunked({ projectDir, project, up, pageSpec, resume }));
  } else {
    console.error("[s3:design] LLM 1/4 — schema.json (DB 역산)…");
    const rSchema = await generateJson({
      basePrompt: fillPrompt("prompt-schema.md", { PROJECT: project, PAGE_SPEC: pageSpec, SPEC: up.spec, CONTEXT: up.context, CORPUS: up.corpus }),
      saveRaw: (raw) => writeFileSync(join(projectDir, ".s3-schema-raw.txt"), raw),
      stamp: (o) => { o.project = project; },
      validate: (o) => validateSchema(o),
      attempts: 2,
      log: (m) => console.error(`[s3:design]   ${m}`),
    });
    schema = rSchema.obj; gv = rSchema.gv;
    for (const w of (gv.warnings || [])) console.error(`[s3:design][warn] ${w}`);
    if (!gv.ok) return failGuard(projectDir, "schema", schema || {}, gv, rSchema.truncated);
  }
  const tableNames = gv.tableNames;
  schema._meta = stampMeta({ stage: "s3-schema", inputsFingerprint: fp("schema") });
  writeFileSync(join(projectDir, "schema.json"), JSON.stringify(schema, null, 2));
  const schemaStr = JSON.stringify(schema, null, 2);
  console.error(`[s3:design]   ✓ 테이블 ${gv.stats.tables}·컬럼 ${gv.stats.columns}·관계 ${gv.stats.relations}`);

  // 2/4 server-spec.json (화면+스키마 역산 → 서버 로직/API · 29엔드포인트 = 큰 출력)  ·  --chunked: 리소스별 청크
  let server;
  if (chunked) {
    ({ obj: server, gv } = await genServerChunked({ projectDir, project, up, pageSpec, pageSpecObj, schemaStr, tableNames, resume }));
  } else {
    console.error("[s3:design] LLM 2/4 — server-spec.json (서버 로직/API 역산)…");
    const rServer = await generateJson({
      basePrompt: fillPrompt("prompt-server.md", { PROJECT: project, PAGE_SPEC: pageSpec, SCHEMA: schemaStr, SPEC: up.spec }),
      saveRaw: (raw) => writeFileSync(join(projectDir, ".s3-server-raw.txt"), raw),
      stamp: (o) => { o.project = project; },
      validate: (o) => validateServerSpec(o, { spec: up.specObj, tableNames, pageSpec: pageSpecObj }),
      attempts: 2,
      log: (m) => console.error(`[s3:design]   ${m}`),
    });
    server = rServer.obj; gv = rServer.gv;
    for (const w of (gv.warnings || [])) console.error(`[s3:design][warn] ${w}`);
    if (!gv.ok) return failGuard(projectDir, "server-spec", server || {}, gv, rServer.truncated);
  }
  server._meta = stampMeta({ stage: "s3-server", inputsFingerprint: fp("server") });
  writeFileSync(join(projectDir, "server-spec.json"), JSON.stringify(server, null, 2));
  console.error(`[s3:design]   ✓ 엔드포인트 ${gv.stats.endpoints}·흐름 ${gv.stats.dataFlow}`);

  // 3/4 acceptance.json (화면+서버 → 테스트 설계, confirmed 바닥 커버리지 · 64테스트 = 큰 출력)
  //   하드가드(바닥 커버리지·setup.role·셀렉터 계약·정책 WRITE 적대 등) 미충족 시 에러를 프롬프트에 피드백해 재시도.
  //   generateJson 이 이 루프를 일반화(가드 피드백 + 잘림 감지). 재시도 3회 유지.  ·  --chunked: 페이지별 청크
  const serverStr = JSON.stringify(server, null, 2);
  let acc;
  if (chunked) {
    ({ obj: acc, gv } = await genAcceptanceChunked({ projectDir, project, up, pageSpec, pageSpecObj, serverStr, server, resume }));
  } else {
    console.error("[s3:design] LLM 3/4 — acceptance.json (테스트 설계)…");
    const rAcc = await generateJson({
      basePrompt: fillPrompt("prompt-acceptance.md", { PROJECT: project, PAGE_SPEC: pageSpec, SERVER_SPEC: serverStr, SPEC: up.spec }),
      saveRaw: (raw) => writeFileSync(join(projectDir, ".s3-acceptance-raw.txt"), raw),
      stamp: (o) => { o.project = project; },
      validate: (o) => validateAcceptance(o, { spec: up.specObj, pageSpec: pageSpecObj, serverSpec: server }),
      attempts: 3,
      log: (m) => console.error(`[s3:design]   ${m}`),
    });
    acc = rAcc.obj; gv = rAcc.gv;
    for (const w of (gv.warnings || [])) console.error(`[s3:design][warn] ${w}`);
    if (!gv.ok) return failGuard(projectDir, "acceptance", acc || {}, gv, rAcc.truncated);
  }
  acc._meta = stampMeta({ stage: "s3-acceptance", inputsFingerprint: fp("acceptance") });
  writeFileSync(join(projectDir, "acceptance.json"), JSON.stringify(acc, null, 2));
  console.error(`[s3:design]   ✓ 테스트 ${gv.stats.tests}(정상 ${gv.stats.normal}/적대 ${gv.stats.adversarial})·셀렉터 ${gv.stats.selectors}·커버 ${gv.stats.coveredConfirmed}/${gv.stats.confirmed}`);

  // ★ 정책 커버리지 교차검증: 화면 역산이 비가시 정책(BR)을 떨궜는지 — server/acceptance 어디에도 없으면 실패
  const rc = validateRuleCoverage(up.specObj, server);
  if (!rc.ok) {
    console.error("[s3:design] 정책 커버리지 실패 — 다음 confirmed businessRule이 서버/테스트 설계에 반영 안 됨(증발):");
    for (const id of rc.uncovered) console.error("  - " + id);
    console.error("  → server-spec endpoint.rules / logic 또는 acceptance에 반영 필요. (page-spec 재검토 후 --phase=design 재실행)");
    process.exit(1);
  }
  console.error(`[s3:design]   ✓ 정책 커버 ${rc.confirmedRules}/${rc.confirmedRules} (모든 confirmed BR 반영)`);

  // 4/4 dev-doc.md (전부 종합 → 구현 가이드, 프로즈)
  console.error("[s3:design] LLM 4/4 — dev-doc.md (개발 문서)…");
  const devRaw = await callLLM(fillPrompt("prompt-dev-doc.md", {
    PROJECT: project, PAGE_SPEC: pageSpec, SCHEMA: schemaStr, SERVER_SPEC: serverStr,
    ACCEPTANCE: JSON.stringify(acc, null, 2), SPEC: up.spec, CONTEXT: up.context,
  }));
  const devDoc = cleanMarkdownDoc(devRaw); // 산문 프리앰블/꼬리말 오염 제거(내부 코드블록 보존)
  if (devDoc.length < 400) console.error(`[s3:design][warn] dev-doc.md가 짧음(${devDoc.length}자)`);
  if ((up.specObj.nfr || []).length && !/비기능|NFR/i.test(devDoc)) console.error("[s3:design][warn] dev-doc.md에 NFR(비기능) 반영 섹션이 안 보임");
  writeFileSync(join(projectDir, "dev-doc.md"), devDoc + "\n");

  const msg = `[${project}] s3 design · 테이블 ${schema.tables.length}·API ${server.endpoints.length}·테스트 ${acc.tests.length}`;
  const commit = commitRun(msg);
  console.error("[s3:design] OK → schema.json + server-spec.json + acceptance.json + dev-doc.md");
  console.error(commit.committed ? `[s3:design] git: 커밋됨 — ${msg}` : `[s3:design] git: skip (${commit.reason})`);
  console.error("");
  console.error("✅ S3 설계 완료. 게이트: '이 설계면 돼요?' → 승인 시 S4(개발)로.");
}

function failGuard(projectDir, name, obj, gv, truncated) {
  writeFileSync(join(projectDir, `${name}.invalid.json`), JSON.stringify(obj, null, 2));
  console.error(`[s3:design] 가드 실패${truncated ? "(잘림 감지 — 재시도 소진)" : ""} → ${name}.invalid.json:`);
  for (const e of gv.errors) console.error("  - " + e);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const projectArg = args.find((a) => !a.startsWith("-"));
  const phase = (args.find((a) => a.startsWith("--phase=")) || "").split("=")[1];
  const imagesOnly = args.includes("--images-only");
  const noImages = args.includes("--no-images") && !imagesOnly;
  const chunked = args.includes("--chunked");
  const resume = args.includes("--resume");
  if (!phase || !["ui", "design"].includes(phase))
    throw new Error("--phase=ui 또는 --phase=design 을 지정하세요 (예: node run.mjs gearloan --phase=ui)");

  const projectDir = resolveProjectDir(projectArg);
  const project = basename(projectDir);
  const up = loadUpstream(projectDir);
  console.error(`[s3] load: context+spec+prd+원자료 · phase=${phase}${chunked ? " · --chunked" + (resume ? " --resume" : "") : ""}`);
  for (const w of stalenessWarnings(projectDir)) console.error(`[s3][stale] ${w}`);

  if (phase === "ui") await phaseUi(projectDir, project, up, { noImages, imagesOnly, chunked, resume });
  else await phaseDesign(projectDir, project, up, { chunked, resume });
}

main().catch((e) => {
  console.error("[s3] ERROR:", e.message);
  process.exit(1);
});
