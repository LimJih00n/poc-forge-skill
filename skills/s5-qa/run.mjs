// s5-qa · 오케(결정적 부분). 실제 브라우저 구동은 Claude가 chrome-devtools MCP로 한다(SKILL.md).
//   node run.mjs prep <project> [--dev] [--port=3210]   → DB wipe · (clean build) · 서버기동 · .s5-plan.json
//   node run.mjs finalize <project>                      → qa-result.raw.json 검증·커버리지·판정·렌더·서버종료·commit
//   ⚠️ prep/finalize 사이에 Claude가 MCP로 .s5-plan.json 을 실행하고 qa-result.raw.json 을 작성한다.
//   가드=코드(guard.mjs)·판단=Claude(MCP). DESIGN.md(skills/s5-qa) 앵커.

import { readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateInputs, buildTestPlan, validateQaResult, validateCoverage, routeLoopback, isBlockingGap } from "./guard.mjs";
import { fingerprint, stampMeta, commitRun, stalenessWarnings } from "../../lib/version.mjs";

const SKILL_DIR = fileURLToPath(new URL(".", import.meta.url));
const readIf = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const jf = (p) => JSON.parse(readFileSync(p, "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolveProjectDir(arg) {
  if (!arg) throw new Error("프로젝트를 지정: node run.mjs <prep|finalize> <project>");
  if (arg.includes("/") || arg.includes("\\")) return resolve(arg);
  return resolve(SKILL_DIR, "..", "..", "runs", arg);
}

// shell 명령(빌드 등 단일 프로세스 — 완주까지 대기). stdout/stderr utf8(한글 청크경계 손상 방지).
function sh(cmd, cwd, { timeout = 0 } = {}) {
  return new Promise((res) => {
    const child = spawn(cmd, { shell: true, cwd });
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const to = timeout ? setTimeout(() => { try { child.kill(); } catch {} }, timeout) : null;
    child.on("error", (e) => { if (to) clearTimeout(to); res({ code: -1, out: out + "\n" + e.message }); });
    child.on("close", (code) => { if (to) clearTimeout(to); res({ code, out }); });
  });
}
// S4와 동일 — Windows stale .next rename flake 감지(재시도 판단).
const isTransientFsError = (s) => /errno:\s*-?4058|\bEPERM\b|\bENOTEMPTY\b|500\.html/i.test(s || "") || (/\brename\b/i.test(s || "") && /\bENOENT\b/i.test(s || ""));

// Windows에서 프로세스 트리 강제 종료(shell 없이 args 직접 — 슬래시 모호성/인젝션 회피).
function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/F", "/T"], { stdio: "ignore" });
  else { try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} } }
}
// 이전 실행이 남긴 서버가 있으면 정리(포트 충돌 예방).
function killPrevServer(projectDir) {
  try { const s = jf(join(projectDir, ".s5-server.json")); if (s.pid) { killTree(s.pid); } } catch {}
}
// 네이티브 fetch 준비 폴링(curl/NUL 이슈 회피). 5xx 미만이면 ready.
async function waitReady(base, { tries = 60, gap = 500 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(base + "/", { signal: AbortSignal.timeout(2500), redirect: "manual" });
      if (r.status < 500) return true;
    } catch { /* 아직 안 뜸 */ }
    await sleep(gap);
  }
  return false;
}

// ── PREP ──────────────────────────────────────────────────────────────────────
async function prep(projectDir, { dev = false, port = 3210 } = {}) {
  const iv = validateInputs(projectDir);
  if (!iv.ok) throw new Error("입력 계약 실패:\n  - " + iv.errors.join("\n  - "));
  for (const w of stalenessWarnings(projectDir)) console.error(`[s5][stale] ${w}`);
  const appDir = join(projectDir, "app");

  killPrevServer(projectDir); // 이전 서버 정리

  // 1) DB wipe — 오늘 기준 재시드(SEED_NOW 상대앵커 드리프트 방지). 서버 기동 시 lazy 재시드됨.
  try {
    const d = join(appDir, "data");
    for (const f of (existsSync(d) ? readdirSync(d) : [])) if (f.endsWith(".db")) rmSync(join(d, f), { force: true });
  } catch {}
  console.error("[s5] DB wipe → 서버 기동 시 오늘 기준 재시드(lazy)");

  // 2) 서버 준비: dev(빌드 없음·behavior QA엔 충분·더 견고) 또는 clean build + start(빌드 그린 증명)
  if (!dev) {
    console.error("[s5] clean build (rm .next → next build)…");
    let built = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { rmSync(join(appDir, ".next"), { recursive: true, force: true }); } catch {}
      const r = await sh("npm run build", appDir, { timeout: 600000 });
      if (r.code === 0) { console.error("[s5]   ✓ 빌드 그린"); built = true; break; }
      if (isTransientFsError(r.out) && attempt < 2) { console.error("[s5]   flaky FS — 재시도"); continue; }
      throw new Error("빌드 실패(그린 아님) — S4 확인. 또는 --dev로 재시도:\n" + r.out.slice(-1500));
    }
    if (!built) throw new Error("빌드 미완(그린 아님)");
  } else {
    console.error("[s5] --dev: 빌드 스킵(next dev 사용)");
  }

  // 3) 서버 기동 — detached + unref 로 prep 종료 후에도 서버 생존(Claude가 MCP로 구동). shell로 npx 해석.
  //    Windows에서도 detached:true 필수(안 그러면 prep 종료 시 서버 동반 종료). windowsHide로 콘솔창 숨김.
  //    child.pid = cmd.exe(shell) → 종료는 taskkill /T 로 트리 전체(killTree).
  const startCmd = dev ? `npx next dev -p ${port}` : `npx next start -p ${port}`;
  const child = spawn(startCmd, { shell: true, cwd: appDir, detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  writeFileSync(join(projectDir, ".s5-server.json"), JSON.stringify({ pid: child.pid, port, dev, startedFor: basename(projectDir) }, null, 2));

  const base = `http://localhost:${port}`;
  const ready = await waitReady(base);
  if (!ready) console.error(`[s5][warn] 서버 ready 확인 실패(:${port}) — 로그/포트 확인. (pid ${child.pid})`);
  else console.error(`[s5]   ✓ 서버 :${port} ready (pid ${child.pid}${dev ? ", dev" : ""})`);

  // 4) 실행 대본 생성(오늘 기준 상대날짜 해석 포함)
  const acc = jf(join(projectDir, "acceptance.json"));
  const spec = jf(join(projectDir, "spec.json"));
  const serverSpec = existsSync(join(projectDir, "server-spec.json")) ? jf(join(projectDir, "server-spec.json")) : {};
  const plan = buildTestPlan(acc, { serverSpec, spec, today: new Date() });
  plan.baseUrl = base;
  plan.generatedAt = new Date().toISOString();
  writeFileSync(join(projectDir, ".s5-plan.json"), JSON.stringify(plan, null, 2));

  const c = plan.counts;
  console.error("");
  console.error(`[s5] PREP 완료. baseUrl=${base}`);
  console.error(`[s5]   대본: UI ${c.ui} · API ${c.api} · 셀렉터 ${c.selectors} · 적대타깃 ${c.adversarialTargets} · 폭(기능 ${c.breadthFeatures}/규칙 ${c.breadthRules})`);
  console.error(`[s5]   로그인: ${plan.login.method} ${base}${plan.login.path} body=${plan.login.body} (role∈{${plan.login.roleValues.join(",")}}, 미인증=스킵)`);
  console.error(`[s5]   접근거부 판정 셀렉터: ${plan.accessDenySelector} (HTTP 200 + 컴포넌트, 403 아님)`);
  console.error(`[s5] ▶ 이제 Claude가 chrome-devtools MCP로 .s5-plan.json 실행(Discover→UI+API+적대+폭) → runs/${basename(projectDir)}/qa-result.raw.json 작성 (절차=SKILL.md)`);
  console.error(`[s5] ▶ 끝나면: node skills/s5-qa/run.mjs finalize ${basename(projectDir)}`);
}

// raw 로드: qa-result.raw.jsonl(그룹별 append 체크포인트, 크래시 안전) 우선 → 없으면 qa-result.raw.json.
//   jsonl 각 줄 = 객체 1건. _t="result"|"gap"|"note"로 분류(없으면 필드로 추론). 손상 라인은 skip(견고).
//   result는 test_id로 dedup(마지막 우선 — 재실행 반영). 이래서 러너가 한 방에 거대 JSON 안 써도 됨.
function loadRaw(projectDir) {
  const jsonl = join(projectDir, "qa-result.raw.jsonl");
  const json = join(projectDir, "qa-result.raw.json");
  if (existsSync(jsonl)) {
    const results = [], gaps = [], notes = [];
    let project = basename(projectDir), lines = 0, bad = 0;
    for (const ln of readFileSync(jsonl, "utf8").split(/\r?\n/)) {
      const s = ln.trim(); if (!s) continue; lines++;
      let o; try { o = JSON.parse(s); } catch { bad++; continue; }
      const t = o._t || (o.test_id ? "result" : (o.ref || o.missing ? "gap" : (o.title || o.detail ? "note" : (o.project ? "meta" : "result"))));
      delete o._t;
      if (t === "result") results.push(o);
      else if (t === "gap") gaps.push(o);
      else if (t === "note") notes.push(o);
      else if (t === "meta" && o.project) project = o.project;
    }
    const dedup = new Map(); for (const r of results) if (r && r.test_id) dedup.set(r.test_id, r);
    if (bad) console.error(`[s5][warn] raw.jsonl 손상 라인 ${bad}개 skip(견고)`);
    console.error(`[s5] raw.jsonl 조립: 결과 ${dedup.size}(라인 ${lines}) · gap ${gaps.length} · note ${notes.length}`);
    return { project, results: [...dedup.values()], gaps, notes };
  }
  if (existsSync(json)) return jf(json);
  return null;
}

// ── FINALIZE ────────────────────────────────────────────────────────────────
async function finalize(projectDir) {
  const proj = basename(projectDir);
  const qa = loadRaw(projectDir);
  if (!qa) throw new Error("qa-result.raw.jsonl / .json 없음 — Claude의 MCP 구동 단계가 먼저 필요(SKILL.md)");

  // 1) 스키마·근거 검증
  const gv = validateQaResult(qa);
  for (const w of gv.warnings) console.error(`[s5][warn] ${w}`);
  if (!gv.ok) { console.error("[s5] qa-result 검증 실패:"); for (const e of gv.errors) console.error("  - " + e); process.exit(1); }

  // 2) 커버리지 교차검증(silent-drop 금지) — 대본 대비 미실행. UI 바닥 미실행은 하드.
  let coverage = null;
  const planPath = join(projectDir, ".s5-plan.json");
  if (existsSync(planPath)) {
    const plan = jf(planPath);
    coverage = validateCoverage(plan, qa);
    if (coverage.missingApi.length) console.error(`[s5][warn] API 미실행 ${coverage.missingApi.length}/${coverage.totalApi}: ${coverage.missingApi.slice(0, 8).join(", ")}${coverage.missingApi.length > 8 ? " …" : ""}`);
    if (coverage.missingUi.length) {
      console.error(`[s5] UI 바닥 커버리지 실패 — 대본 ${coverage.totalUi}개 중 ${coverage.missingUi.length}개 미실행(silent-drop 금지):`);
      console.error("  - " + coverage.missingUi.join(", "));
      console.error("[s5] ▶ 누락 UI 테스트를 마저 실행해 qa-result.raw.json 에 추가한 뒤 finalize 재실행.");
      process.exit(1);
    }
  } else {
    console.error("[s5][warn] .s5-plan.json 없음 — 커버리지 교차검증 스킵(prep 없이 finalize?)");
  }

  // 3) 판정
  const results = qa.results || [];
  const gaps = qa.gaps || [];
  const notes = qa.notes || [];
  const failed = results.filter((r) => r.pass === false);
  const blockingGaps = gaps.filter(isBlockingGap);
  const passed = failed.length === 0 && blockingGaps.length === 0;
  const loopback = passed ? null : routeLoopback(qa);

  const cat = (r) => (/^API-/.test(r.test_id) ? "api" : (r.type === "adversarial" ? "adversarial" : "ui"));
  const bucket = { ui: { pass: 0, total: 0 }, api: { pass: 0, total: 0 }, adversarial: { pass: 0, total: 0 } };
  for (const r of results) { const k = cat(r); bucket[k].total++; if (r.pass) bucket[k].pass++; }

  const out = {
    project: proj,
    passed,
    summary: {
      total: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
      floorPass: failed.length === 0,
      breadthGaps: gaps.length,
      blockingGaps: blockingGaps.length,
      byType: bucket,
      ...(coverage ? { coverage: { ui: `${coverage.ranUi}/${coverage.totalUi}`, api: `${coverage.ranApi}/${coverage.totalApi}` } } : {}),
    },
    results,
    gaps,
    notes,
    loopback,
  };
  out._meta = stampMeta({
    stage: "s5-qa",
    inputsFingerprint: fingerprint([readIf(join(projectDir, "acceptance.json")), JSON.stringify(results), JSON.stringify(gaps)]),
  });
  writeFileSync(join(projectDir, "qa-result.json"), JSON.stringify(out, null, 2));
  writeFileSync(join(projectDir, "qa-result.md"), renderQaMd(out));

  // 4) 서버 종료
  try { const srv = jf(join(projectDir, ".s5-server.json")); if (srv.pid) { killTree(srv.pid); console.error(`[s5] 서버 종료(pid ${srv.pid})`); } } catch {}

  // 5) 커밋
  const msg = `[${proj}] s5 qa · ${out.summary.passed}/${out.summary.total} pass · gap ${out.summary.breadthGaps}(차단 ${out.summary.blockingGaps})${loopback ? ` · loopback→${loopback.stage}` : " · PASS"}`;
  const commit = commitRun(msg);
  console.error(`[s5] FINALIZE: ${out.passed ? "✅ PASS" : "❌ FAIL"} — ${msg}`);
  console.error(commit.committed ? "[s5] git: 커밋됨" : `[s5] git: skip (${commit.reason})`);
  if (loopback) console.error(`[s5] ▶ 루프백: ${loopback.stage} 재실행 필요 — ${loopback.reason}`);
}

// ── 결정적 렌더(사람용 리포트) ─────────────────────────────────────────────────
export function renderQaMd(o) {
  const s = o.summary, b = s.byType;
  const L = [];
  L.push(`# QA 결과 — ${o.project}`, "");
  L.push(`**${o.passed ? "✅ PASS" : "❌ FAIL"}** · ${s.passed}/${s.total} 통과 · 폭 gap ${s.breadthGaps}(차단 ${s.blockingGaps})${o.loopback ? ` · 루프백 → ${o.loopback.stage}` : ""}`, "");
  L.push("| 차원 | 통과 | 계 |", "|---|---|---|");
  L.push(`| UI(바닥) | ${b.ui.pass} | ${b.ui.total} |`);
  L.push(`| 적대(UI) | ${b.adversarial.pass} | ${b.adversarial.total} |`);
  L.push(`| API | ${b.api.pass} | ${b.api.total} |`);
  if (s.coverage) L.push("", `커버리지: UI ${s.coverage.ui} · API ${s.coverage.api} (대본 대비 실행)`);
  L.push("");

  const fails = o.results.filter((r) => r.pass === false);
  if (fails.length) {
    L.push("## ❌ 실패", "");
    for (const r of fails) {
      L.push(`- **${r.test_id}**${r.feature_id ? ` (${r.feature_id}` : ""}${r.role ? `, ${r.role}` : ""}${r.feature_id || r.role ? ")" : ""} — ${r.failReason || r.rationale || "?"}`);
      L.push(`  - 근거: ${r.evidence || "-"}`);
      L.push(`  - 원인: **${r.cause || "?"}**`);
    }
    L.push("");
  }
  if ((o.gaps || []).length) {
    L.push("## 📏 폭 gap (테스트가 놓친 spec 대비 누락/불일치)", "");
    for (const g of o.gaps) {
      const block = isBlockingGap(g) ? "" : " _(비차단)_";
      L.push(`- **${g.ref || "?"}** (${g.kind || "gap"}${g.severity ? `, ${g.severity}` : ""})${block} — ${g.missing || "?"}`);
      if (g.evidence) L.push(`  - 근거: ${g.evidence}`);
      if (g.cause) L.push(`  - 원인: **${g.cause}**`);
    }
    L.push("");
  }
  if ((o.notes || []).length) {
    L.push("## 📝 관찰 (비차단 — 의심보안·개선점, 사람 후속)", "");
    for (const n of o.notes) L.push(`- ${typeof n === "string" ? n : `${n.title || n.ref || ""}: ${n.detail || n.note || ""}${n.evidence ? ` (근거: ${n.evidence})` : ""}`}`);
    L.push("");
  }
  if (o.loopback) {
    L.push("## 🔁 루프백", "", `- **${o.loopback.stage}** 재실행 — ${o.loopback.reason}`, "");
  }
  L.push(`_생성: ${o._meta?.generatedAt || ""} · fingerprint ${o._meta?.inputsFingerprint || ""}_`, "");
  return L.join("\n") + "\n";
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  const [cmd, projArg, ...rest] = process.argv.slice(2);
  const dev = rest.includes("--dev");
  const port = parseInt((rest.find((a) => a.startsWith("--port=")) || "").split("=")[1] || "3210", 10);
  const projectDir = resolveProjectDir(projArg);
  if (cmd === "prep") return prep(projectDir, { dev, port });
  if (cmd === "finalize") return finalize(projectDir);
  throw new Error("사용법: node run.mjs <prep|finalize> <project> [--dev] [--port=N]");
}
// 엔트리 가드: 직접 실행일 때만 main() (import 시 부작용 없음 — 단위 테스트/재사용 가능).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error("[s5] ERROR:", e.message); process.exit(1); });
}
