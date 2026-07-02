// orchestrator/engine.test.mjs — 순수 두뇌 단위 + mock E2E(실 claude/스테이지 없음).
//   실행: node orchestrator/engine.test.mjs   (녹색이면 exit 0)
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  initManifest, nextAction, recordStart, recordResult, approveGate,
  applyLoopback, computeFreshness, saveManifest, loadManifest,
} from "./engine.mjs";
import { STEPS, MAX_ROUNDS, stepById } from "./pipeline.mjs";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error("  ✗ " + msg); } };
const eq = (a, b, msg) => ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// 임시 프로젝트 디렉토리(테스트마다 격리)
let SEQ = 0;
function freshDir() {
  const d = join(tmpdir(), `pf-orch-test-${process.pid}-${SEQ++}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(join(d, "sources"), { recursive: true });
  writeFileSync(join(d, "sources", "brief.md"), "# 초기 소스\n장비 대여 브리프");
  return d;
}
const write = (dir, rel, content = "x") => {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
};

/** 스텝 실행 시뮬레이션: produces 파일 기록 + recordResult. terminal 은 qa 로 passed/loopback 제어. */
function simulateRun(dir, m, stepId, { qa, exitCode = 0, skipProduces = false } = {}) {
  const step = stepById(stepId);
  if (!skipProduces) {
    for (const f of step.produces) {
      if (step.terminal && f === "qa-result.json") continue; // 아래서 qa 로 기록
      write(dir, f, `content-${stepId}-${f}`);
    }
    if (step.terminal) {
      const payload = qa || { passed: true, loopback: null };
      write(dir, "qa-result.json", JSON.stringify({ project: m.project, ...payload }));
    }
  }
  return recordResult(m, dir, stepId, { exitCode });
}

/** 게이트 자동승인하며 done 까지 걷기(loopback 훅 옵션). 결과 액션 반환. */
function walk(dir, m, { onFinalize } = {}) {
  for (let guard = 0; guard < 100; guard++) {
    m = computeFreshness(m, dir);
    const act = nextAction(m, dir);
    if (act.type === "done" || act.type === "blocked") return { act, m };
    if (act.type === "await-gate") { approveGate(m, act.stepId); continue; }
    if (act.type === "loopback") { applyLoopback(m, dir); continue; }
    if (act.type === "run") {
      recordStart(m, act.stepId);
      const qa = act.stepId === "s5-finalize" && onFinalize ? onFinalize(m) : undefined;
      simulateRun(dir, m, act.stepId, { qa });
      continue;
    }
  }
  throw new Error("walk 무한루프 — 100 스텝 초과");
}

// ══════════════════════════ 1. initManifest ══════════════════════════
{
  const m = initManifest("demo");
  eq(Object.keys(m.steps).length, 8, "1.1 8스텝 생성");
  eq(m.steps.s1.status, "pending", "1.2 s1 pending");
  eq(m.round, 0, "1.3 round 0");
  ok(m.steps.s1.gate && !m.steps.s1.gate.approved, "1.4 s1 게이트 미승인");
  ok(!m.steps["s5-prep"].gate, "1.5 s5-prep 게이트 없음");
  ok(!!m.steps.s4.gate, "1.6 s4 사람 게이트 존재(사용자 결정)");
}

// ══════════════════════════ 2. nextAction 신규 → s1 ══════════════════════════
{
  const dir = freshDir();
  const m = initManifest("demo");
  const act = nextAction(m, dir);
  eq(act.type, "run", "2.1 신규 → run");
  eq(act.stepId, "s1", "2.2 첫 스텝 s1");
  ok(Array.isArray(act.cmd) && act.cmd[0].includes("s1-understand"), "2.3 cmd = s1 run.mjs");
}

// ══════════════════════════ 3. no-skip + 게이트 차단 ══════════════════════════
{
  const dir = freshDir();
  let m = initManifest("demo");
  recordStart(m, "s1"); simulateRun(dir, m, "s1");
  eq(m.steps.s1.status, "done", "3.1 s1 done");
  let act = nextAction(m, dir);
  eq(act.type, "await-gate", "3.2 s1 done → 게이트 대기");
  eq(act.stepId, "s1", "3.3 게이트 대상 s1");
  // 승인 전엔 s2 못 감
  ok(nextAction(m, dir).type === "await-gate", "3.4 미승인 시 계속 게이트(no-skip)");
  approveGate(m, "s1");
  act = nextAction(m, dir);
  eq(act.type, "run", "3.5 승인 후 run");
  eq(act.stepId, "s2", "3.6 다음 = s2");
}

// ══════════════════════════ 4. 성공 마커 재검증(exit0 여도 마커 없으면 failed) ══════════════════════════
{
  const dir = freshDir();
  let m = initManifest("demo");
  recordStart(m, "s1");
  recordResult(m, dir, "s1", { exitCode: 0 }); // produces 안 씀 → context.json 없음
  eq(m.steps.s1.status, "failed", "4.1 마커 없으면 exit0 여도 failed");
  eq(nextAction(m, dir).stepId, "s1", "4.2 failed → 그 스텝 재실행");
  // exit!=0
  write(dir, "context.json", "{}");
  recordResult(m, dir, "s1", { exitCode: 1 });
  eq(m.steps.s1.status, "failed", "4.3 exit!=0 → failed");
}

// ══════════════════════════ 5. 전체 mock E2E → PASS(done) ══════════════════════════
{
  const dir = freshDir();
  let m = initManifest("demo");
  ({ m } = walk(dir, m)); // onFinalize 기본 = passed
  const act = nextAction(m, dir);
  eq(act.type, "done", "5.1 전 스텝 통과 → done");
  eq(act.reason, "S5 PASS", "5.2 PASS 사유");
  ok(STEPS.every((s) => m.steps[s.id].status === "done"), "5.3 모든 스텝 done");
  ok(!m.steps["s5-finalize"].gate && m.steps["s5-finalize"].qa.passed, "5.4 finalize 게이트없음 + qa passed 기록");
}

// ══════════════════════════ 6. 루프백(S4) → 재흐름 → PASS ══════════════════════════
{
  const dir = freshDir();
  let m = initManifest("demo");
  // 1라운드: finalize 에서 S4 loopback
  let round = 0;
  ({ m } = walk(dir, m, {
    onFinalize: () => (round++ === 0
      ? { passed: false, loopback: { stage: "S4", reason: "announcements 접근제어 갭", breakdown: { S4: 1 } } }
      : { passed: true, loopback: null }),
  }));
  const act = nextAction(m, dir);
  eq(act.type, "done", "6.1 루프백 후 재흐름 → done");
  eq(m.round, 1, "6.2 라운드 1 기록");
  eq(m.loopbacks.length, 1, "6.3 loopback 이력 1건");
  eq(m.loopbacks[0].to, "S4", "6.4 착지 S4");
  eq(m.loopbacks[0].target, "s4", "6.5 타깃 스텝 s4");
}

// ══════════════════════════ 7. 루프백 cap 초과 → blocked ══════════════════════════
{
  const dir = freshDir();
  let m = initManifest("demo");
  // 항상 fail loopback → cap(2) 초과 시 blocked
  const { act } = walk(dir, m, {
    onFinalize: () => ({ passed: false, loopback: { stage: "S3", reason: "설계 갭", breakdown: { S3: 1 } } }),
  });
  eq(act.type, "blocked", "7.1 cap 초과 → blocked");
  ok(/cap/.test(act.reason), "7.2 blocked 사유 = cap");
  eq(m.round, MAX_ROUNDS, `7.3 라운드 = cap(${MAX_ROUNDS})`);
  // S3 루프백은 s3-ui 로 착지(사용자 결정)
  ok(m.loopbacks.every((l) => l.target === "s3-ui"), "7.4 S3 루프백 → s3-ui 착지");
}

// ══════════════════════════ 8. 판정 이상(passed=false·loopback=null) → blocked ══════════════════════════
{
  const dir = freshDir();
  let m = initManifest("demo");
  ({ m } = walk(dir, m, { onFinalize: () => ({ passed: false, loopback: null }) }));
  const act = nextAction(m, dir);
  eq(act.type, "blocked", "8.1 passed=false·loopback=null → blocked(오판 방지)");
  ok(/이상/.test(act.reason), "8.2 blocked 사유 = 판정 이상");
}

// ══════════════════════════ 9. 신선도: 상류 파일 변경 → stale + 게이트 재승인 ══════════════════════════
{
  const dir = freshDir();
  let m = initManifest("demo");
  ({ m } = walk(dir, m)); // 전부 done(게이트 자동승인)
  eq(nextAction(m, dir).type, "done", "9.0 초기 done");
  // s2 의 상류(context.json) 변경 → s2 stale
  write(dir, "context.json", "content-s1-context.json -- CHANGED");
  m = computeFreshness(m, dir);
  eq(m.steps.s2.status, "stale", "9.1 상류 변경 → s2 stale");
  ok(m.steps.s2.gate && !m.steps.s2.gate.approved, "9.2 stale → 게이트 재승인 필요");
  const act = nextAction(m, dir);
  eq(act.type, "run", "9.3 stale → 재실행 유도");
  eq(act.stepId, "s2", "9.4 재실행 대상 = s2(상류부터)");
}

// ══════════════════════════ 10. manifest 저장/로드 왕복 ══════════════════════════
{
  const dir = freshDir();
  let m = initManifest("demo");
  recordStart(m, "s1"); simulateRun(dir, m, "s1"); approveGate(m, "s1");
  saveManifest(dir, m);
  ok(existsSync(join(dir, "poc.manifest.json")), "10.1 manifest 파일 생성");
  const m2 = loadManifest(dir);
  eq(m2.steps.s1.status, "done", "10.2 로드 후 상태 보존");
  ok(m2.steps.s1.gate.approved, "10.3 게이트 승인 보존");
}

// ── 결과 ──
console.error(`\n[orchestrator engine] ${pass} pass · ${fail} fail`);
process.exit(fail ? 1 : 0);
