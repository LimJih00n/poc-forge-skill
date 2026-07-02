// orchestrator/engine.mjs — poc-forge 오케스트레이터 "두뇌"(순수 판단 + manifest IO).
//   원칙(사용자 결정): 엔진은 스테이지를 절대 spawn 하지 않는다. "무엇을/언제 할지" 결정만 한다.
//   실제 실행(서브프로세스·S4 서브에이전트·S5 MCP·사람 게이트)은 SKILL.md(Claude)가.
//   = S5 에서 검증된 분업("가드=코드, 판단/구동=Claude")을 파이프라인 전체로.
//   재사용: lib/version.mjs(fingerprint·commitRun). 도메인 로직 0.

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fingerprint, commitRun } from "../lib/version.mjs";
import { STEPS, MAX_ROUNDS, LOOPBACK_LANDING, stepById } from "./pipeline.mjs";

const nowIso = () => new Date().toISOString();

// ───────────────────────── manifest IO (유일한 부작용) ─────────────────────────
export function manifestPath(dir) {
  return join(dir, "poc.manifest.json");
}

/** 새 manifest — 8스텝 pending, 사람 게이트가 있는 스텝은 gate 미승인.
 *  mode: "attended"(사람 게이트) | "unattended"(게이트 자동승인) — 실행 시작 시 결정(사용자 결정 #5). */
export function initManifest(project, { mode = "attended" } = {}) {
  const steps = {};
  for (const s of STEPS) {
    steps[s.id] = {
      status: "pending",
      ranAt: null,
      upstreamHash: null,
      ...(s.gate ? { gate: { required: true, approved: false, who: s.gate.who } } : {}),
    };
  }
  return { project, schema: 1, mode, round: 0, current_step: null, steps, loopbacks: [] };
}

export function loadManifest(dir) {
  const p = manifestPath(dir);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

export function saveManifest(dir, m) {
  writeFileSync(manifestPath(dir), JSON.stringify(m, null, 2) + "\n");
  return m;
}

// ───────────────────────── 신선도(DESIGN §10 핵심위험) ─────────────────────────
/** reads[] 파일/디렉토리 내용의 짧은 지문. 없음 = 안정 센티넬(오탐 방지). */
function hashReads(dir, reads) {
  const parts = [];
  for (const rel of reads || []) {
    const p = join(dir, rel);
    try {
      const st = statSync(p);
      if (st.isDirectory()) {
        for (const f of readdirSync(p).sort()) {
          const fp = join(p, f);
          try { if (statSync(fp).isFile()) parts.push(f, readFileSync(fp, "utf8")); } catch { /* skip */ }
        }
      } else {
        parts.push(rel, readFileSync(p, "utf8"));
      }
    } catch {
      parts.push(rel, "∅"); // 없음
    }
  }
  return fingerprint(parts);
}

/**
 * done 스텝의 상류(reads)가 마지막 실행 이후 변했으면 stale + 게이트 재승인 필요로 표시.
 * 상류 재실행이 하류의 reads(계약파일)를 바꾸므로 캐스케이드는 자연히 전파된다.
 */
export function computeFreshness(m, dir) {
  for (const step of STEPS) {
    const st = m.steps[step.id];
    if (st.status !== "done") continue;
    const cur = hashReads(dir, step.reads);
    if (st.upstreamHash != null && cur !== st.upstreamHash) {
      st.status = "stale";
      if (st.gate) st.gate.approved = false;
    }
  }
  return m;
}

// ───────────────────────── 성공 마커(디스크 재검증) ─────────────────────────
function markerOk(dir, step) {
  const { files, mode = "all" } = step.successMarker;
  const one = (f) => {
    try { const s = statSync(join(dir, f)); return s.isFile() ? s.size > 0 : s.isDirectory(); }
    catch { return false; }
  };
  return mode === "any" ? files.some(one) : files.every(one);
}

/** s5-finalize 판정 = qa-result.json 의 passed/loopback(exit code 아님). */
function readQa(dir) {
  try {
    const q = JSON.parse(readFileSync(join(dir, "qa-result.json"), "utf8"));
    return { passed: !!q.passed, loopback: q.loopback ?? null };
  } catch {
    return null;
  }
}

// ───────────────────────── 상태 전이 ─────────────────────────
export function recordStart(m, stepId) {
  m.steps[stepId].status = "running";
  m.current_step = stepId;
  return m;
}

/**
 * 스텝 실행 결과 반영. SKILL 이 관찰한 exitCode 를 넘기면 엔진이 successMarker 로 디스크 재검증.
 * 성공: status=done, upstreamHash 갱신, 사람 게이트는 미승인(재승인 대기), terminal 은 qa 기록.
 * 실패: status=failed.
 */
export function recordResult(m, dir, stepId, { exitCode = 0 } = {}) {
  const step = stepById(stepId);
  const st = m.steps[stepId];
  const ok = exitCode === 0 && markerOk(dir, step);
  if (!ok) { st.status = "failed"; return m; }
  st.status = "done";
  st.ranAt = nowIso();
  st.upstreamHash = hashReads(dir, step.reads);
  if (st.gate) st.gate.approved = false; // 모든 게이트 = 사람 승인 대기(build-green 은 스테이지가 이미 강제)
  if (step.terminal) st.qa = readQa(dir) || { passed: false, loopback: null };
  return m;
}

export function approveGate(m, stepId) {
  const g = m.steps[stepId].gate;
  if (g) { g.approved = true; g.at = nowIso(); }
  return m;
}

/** S5 loopback → 착지 스텝 + 하류 전부 pending 리셋, 라운드++·이력 기록. (cap 검사는 nextAction 이 선행) */
export function applyLoopback(m, dir) {
  const qa = m.steps["s5-finalize"].qa || readQa(dir) || {};
  const lb = qa.loopback;
  if (!lb) return m;
  const target = LOOPBACK_LANDING[lb.stage];
  const idx = STEPS.findIndex((s) => s.id === target);
  for (let i = idx; i < STEPS.length; i++) {
    const st = m.steps[STEPS[i].id];
    st.status = "pending";
    if (st.gate) st.gate.approved = false;
    delete st.qa;
  }
  m.round += 1;
  m.loopbacks.push({ round: m.round, from: "s5-finalize", to: lb.stage, target, reason: lb.reason || "", at: nowIso() });
  return m;
}

// ───────────────────────── ★ 다음 액션(순수 판단, no-skip) ─────────────────────────
/**
 * 파이프라인을 순서대로 걸으며 "지금 할 한 가지"를 반환.
 *   - done 이고 게이트 미승인 → await-gate (여기서 멈춤 = no-skip 보장)
 *   - done 이고 terminal → qa 로 done|loopback|blocked
 *   - done 아님(pending/stale/failed/running) → run (상류는 전부 done+승인 상태로 여기 도달)
 * @returns {{type:"run"|"await-gate"|"loopback"|"done"|"blocked", ...}}
 */
export function nextAction(m, dir) {
  for (const step of STEPS) {
    const st = m.steps[step.id];

    if (st.status === "done") {
      if (st.gate?.required && !st.gate.approved) {
        return { type: "await-gate", stepId: step.id, stage: step.stage, question: step.gate.question, precondition: step.gate.precondition };
      }
      if (step.terminal) {
        const qa = st.qa || readQa(dir) || { passed: false, loopback: null };
        if (qa.passed) return { type: "done", reason: "S5 PASS" };
        if (qa.loopback) {
          if (m.round >= MAX_ROUNDS)
            return { type: "blocked", reason: `루프백 cap(${MAX_ROUNDS}) 초과 — 사람 개입 필요`, loopback: qa.loopback };
          return { type: "loopback", loopback: qa.loopback, targetStep: LOOPBACK_LANDING[qa.loopback.stage] };
        }
        return { type: "blocked", reason: "판정 이상: passed=false 인데 loopback=null(원인 오염 가능)" };
      }
      continue; // 게이트 통과 → 다음 스텝
    }

    // done 아님 → no-skip 상 상류는 전부 done+승인 → 이게 다음 실행 대상
    return {
      type: "run", stepId: step.id, stage: step.stage, kind: step.kind, statusWas: st.status,
      cmd: step.cmd ? step.cmd(m.project) : null, gate: step.gate || null,
    };
  }
  return { type: "done", reason: "전 스텝 완료" };
}

// ───────────────────────── 사람용 상태 요약 ─────────────────────────
export function summarize(m) {
  const icon = { pending: "·", running: "▶", stale: "~", done: "✓", failed: "✗", blocked: "⛔" };
  const rows = STEPS.map((s) => {
    const st = m.steps[s.id];
    const g = st.gate ? (st.gate.approved ? " (게이트✓)" : st.status === "done" ? " (게이트 대기)" : "") : "";
    return `  ${icon[st.status] || "?"} ${s.id.padEnd(12)} ${st.status}${g}`;
  });
  return `[${m.project}] ${m.mode || "attended"} · round ${m.round} · current=${m.current_step || "-"}\n${rows.join("\n")}` +
    (m.loopbacks.length ? `\n  loopbacks: ${m.loopbacks.map((l) => `r${l.round}→${l.to}`).join(", ")}` : "");
}

// ───────────────────────── 커밋(오케 전용 변경: 게이트/루프백) ─────────────────────────
export function commitOrchestrator(project, event) {
  return commitRun(`[${project}] orchestrator · ${event}`);
}
