// orchestrator/cli.mjs — 엔진(순수 두뇌)의 얇은 CLI 껍데기. Claude(SKILL.md)가 Bash 로 호출.
//   ★ 스테이지를 실행하지 않는다 — "다음 뭐할지" 결정을 표면화하고 결과를 기록만 한다.
//      실제 실행(node run.mjs·서브에이전트·MCP·사람 게이트)은 SKILL(Claude).
//   결정(stdout)=JSON, 사람용 요약(stderr). manifest 는 매 명령마다 로드→변경→저장.
//
//   명령:
//     node orchestrator/cli.mjs init     <project> [--auto]   manifest 생성(없으면). --auto=무인(게이트 자동)
//     node orchestrator/cli.mjs status   <project>            신선도 갱신 + 요약 + 다음 액션
//     node orchestrator/cli.mjs next     <project>            다음 액션만(JSON)
//     node orchestrator/cli.mjs start    <project> <stepId>   status=running 기록
//     node orchestrator/cli.mjs record   <project> <stepId> <exitCode>   실행 결과 기록(마커 재검증)
//     node orchestrator/cli.mjs approve  <project> <stepId>   사람 게이트 승인 + 커밋
//     node orchestrator/cli.mjs loopback <project>            S5 loopback 적용(착지+하류 리셋) + 커밋
//     node orchestrator/cli.mjs list                          runs/* 전 프로젝트 상태 요약

import { resolve, basename, join } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import { POC_FORGE_ROOT } from "../lib/version.mjs";
import * as E from "./engine.mjs";

const [cmd, projArg, ...rest] = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o, null, 2) + "\n");
const projectDir = (arg) => {
  if (!arg) throw new Error("프로젝트를 지정하세요: cli.mjs <cmd> <project>");
  return /[\\/]/.test(arg) ? resolve(arg) : resolve(POC_FORGE_ROOT, "runs", arg);
};
const loadOrDie = (dir) => {
  const m = E.loadManifest(dir);
  if (!m) throw new Error(`manifest 없음(${dir}) — 먼저 'init'`);
  return m;
};

try {
  switch (cmd) {
    case "init": {
      const dir = projectDir(projArg);
      const auto = rest.includes("--auto");
      let m = E.loadManifest(dir);
      let created = false;
      if (!m) { m = E.initManifest(basename(dir), { mode: auto ? "unattended" : "attended" }); created = true; }
      else if (auto && m.mode !== "unattended") m.mode = "unattended";
      E.saveManifest(dir, m);
      console.error(E.summarize(m));
      out({ ok: true, created, mode: m.mode, next: E.nextAction(m, dir) });
      break;
    }
    case "status": {
      const dir = projectDir(projArg);
      let m = E.computeFreshness(loadOrDie(dir), dir);
      E.saveManifest(dir, m);
      console.error(E.summarize(m));
      out({ mode: m.mode, round: m.round, next: E.nextAction(m, dir) });
      break;
    }
    case "next": {
      const dir = projectDir(projArg);
      let m = E.computeFreshness(loadOrDie(dir), dir);
      E.saveManifest(dir, m);
      out(E.nextAction(m, dir));
      break;
    }
    case "start": {
      const dir = projectDir(projArg);
      const step = rest[0];
      const m = E.recordStart(loadOrDie(dir), step);
      E.saveManifest(dir, m);
      out({ ok: true, started: step });
      break;
    }
    case "record": {
      const dir = projectDir(projArg);
      const step = rest[0];
      const exitCode = parseInt(rest[1] || "0", 10);
      const m = E.recordResult(loadOrDie(dir), dir, step, { exitCode });
      E.saveManifest(dir, m);
      console.error(E.summarize(m));
      out({ ok: true, step, status: m.steps[step].status, next: E.nextAction(m, dir) });
      break;
    }
    case "approve": {
      const dir = projectDir(projArg);
      const step = rest[0];
      const m = E.approveGate(loadOrDie(dir), step);
      E.saveManifest(dir, m);
      const commit = E.commitOrchestrator(m.project, `게이트 승인: ${step}`);
      out({ ok: true, approved: step, commit, next: E.nextAction(m, dir) });
      break;
    }
    case "loopback": {
      const dir = projectDir(projArg);
      const m = E.applyLoopback(loadOrDie(dir), dir);
      E.saveManifest(dir, m);
      const last = m.loopbacks[m.loopbacks.length - 1] || null;
      const commit = last ? E.commitOrchestrator(m.project, `loopback r${last.round}→${last.to}`) : null;
      console.error(E.summarize(m));
      out({ ok: true, loopback: last, commit, next: E.nextAction(m, dir) });
      break;
    }
    case "list": {
      const runsDir = join(POC_FORGE_ROOT, "runs");
      const rows = [];
      for (const name of existsSync(runsDir) ? readdirSync(runsDir).sort() : []) {
        const dir = join(runsDir, name);
        if (!statSync(dir).isDirectory()) continue;
        const m = E.loadManifest(dir);
        if (!m) { rows.push({ project: name, managed: false }); continue; }
        const mf = E.computeFreshness(m, dir);
        const act = E.nextAction(mf, dir);
        rows.push({ project: name, managed: true, mode: mf.mode, round: mf.round, current: mf.current_step, next: act.type, nextStep: act.stepId || act.reason });
      }
      out({ ok: true, projects: rows });
      break;
    }
    default:
      throw new Error(`알 수 없는 명령: ${cmd || "(없음)"} — init|status|next|start|record|approve|loopback|list`);
  }
} catch (e) {
  process.stderr.write("[orchestrator cli] ERROR: " + e.message + "\n");
  out({ ok: false, error: e.message });
  process.exit(1);
}
