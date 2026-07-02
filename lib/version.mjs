// poc-forge 공용 버전 헬퍼 (모든 스테이지 스킬 공용)
//  - fingerprint(): 입력 지문 → 상류 변경 감지(stale 판정용, manifest가 소비)
//  - commitRun(): best-effort git 커밋 (repo 아니면 조용히 skip). 이력 = Git.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { statSync } from "node:fs";

// lib/version.mjs → poc-forge/
export const POC_FORGE_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

/** 여러 문자열 조각의 짧은 sha256 지문(앞 12자). 소스가 바뀌면 지문이 바뀐다. */
export function fingerprint(parts) {
  const h = createHash("sha256");
  for (const p of parts) h.update(String(p));
  return h.digest("hex").slice(0, 12);
}

/** 산출물 메타 도장 — 버전 정체성 + stale 추적 기초. */
export function stampMeta({ stage, round, inputCount, inputsFingerprint, extra } = {}) {
  return {
    stage,
    generatedAt: new Date().toISOString(),
    ...(round != null ? { round } : {}),
    ...(inputCount != null ? { inputCount } : {}),
    ...(inputsFingerprint ? { inputsFingerprint } : {}),
    ...(extra || {}),
  };
}

// 파이프라인 산출 신선도(mtime) 점검 체인 — 상류→하류. 오케스트레이터(manifest) 전까지의 경량 안전망.
const STAGE_CHAIN = [
  { stage: "S1", outputs: ["context.json"] },
  { stage: "S2", outputs: ["spec.json"] },
  { stage: "S3", outputs: ["page-spec.json", "schema.json", "server-spec.json", "acceptance.json", "dev-doc.md"] },
  { stage: "S4", outputs: ["app/.s4-meta.json"] },
  { stage: "S5", outputs: ["qa-result.json"] },
];

/**
 * mtime 기반 stale 경고: 상류 스테이지 산출이 하류보다 최신이면(= 상류 재실행 후 하류 미재생성) 경고 목록 반환.
 * DESIGN §10의 "★핵심 위험"(S1 재실행 → 하류 stale)을 오케스트레이터 없이도 최소 탐지. 하드 아님(경고).
 */
export function stalenessWarnings(projectDir) {
  const mtime = (rel) => { try { return statSync(join(projectDir, rel)).mtimeMs; } catch { return null; } };
  const rows = STAGE_CHAIN.map((s) => {
    const ms = s.outputs.map(mtime).filter((m) => m != null);
    return { stage: s.stage, newest: ms.length ? Math.max(...ms) : null, oldest: ms.length ? Math.min(...ms) : null };
  });
  const warns = [];
  for (let i = 1; i < rows.length; i++) {
    const down = rows[i];
    if (down.oldest == null) continue; // 아직 생성 안 됨
    for (let j = 0; j < i; j++) {
      const up = rows[j];
      if (up.newest != null && up.newest > down.oldest + 1000) { // 1초 여유
        warns.push(`${down.stage} 산출이 ${up.stage}보다 오래됨 — ${up.stage} 재실행 후 하류 재생성 필요(stale 가능)`);
        break;
      }
    }
  }
  return warns;
}

/** best-effort git 커밋. repo가 아니거나 변경이 없으면 조용히 skip(비치명). */
export function commitRun(message, { cwd = POC_FORGE_ROOT } = {}) {
  const inRepo = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, encoding: "utf8" });
  if (inRepo.status !== 0) return { committed: false, reason: "git repo 아님 (git init 필요)" };
  spawnSync("git", ["add", "-A"], { cwd });
  let res = spawnSync("git", ["commit", "-m", message], { cwd, encoding: "utf8" });
  const blob = (res.stderr || "") + (res.stdout || "");
  if (res.status !== 0 && /identity|user\.(email|name)|tell me who you are/i.test(blob)) {
    // git identity 미설정 → 봇 정체성으로 폴백
    res = spawnSync("git", ["-c", "user.name=poc-forge", "-c", "user.email=poc-forge@local", "commit", "-m", message], { cwd, encoding: "utf8" });
  }
  if (res.status !== 0) {
    const out = ((res.stdout || "") + (res.stderr || "")).trim();
    return { committed: false, reason: /nothing to commit/i.test(out) ? "변경 없음" : out.slice(0, 200) };
  }
  return { committed: true };
}
