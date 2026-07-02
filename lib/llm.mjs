// lib/llm.mjs — LLM 호출 + 견고한 JSON 생성(잘림 감지 + 가드 피드백 재시도). poc-forge 전 스테이지 공용.
//
//   왜: S1~S3의 큰 단일-completion JSON(특히 S2 spec 100행 ≈ 출력한도 근접 · S3 server 29엔드포인트 ·
//   acceptance 64테스트)이 출력 한도 근처에서 잘리면(truncation), 예전엔 extractJson 이 조용히 작은
//   조각으로 축소 → 가드가 "features 비었음" 등으로 실패 → 스테이지 통째 중단(.invalid.json) → 수동 재실행.
//   자동복구는 S3 acceptance 루프에만 있었다.
//   → 여기서 (1) 잘림을 *감지*하고(analyzeJson) (2) 잘림·파싱·가드 실패를 피드백해 재생성한다.
//      신선한 completion 은 변동성 + "더 간결히" 유도로 대개 한도 안에 들어맞는다.
//   판단 기준(핸드오프 §15.2): 관측된 잘림이 없으면 청크화(과대개편)하지 않고 이 감지+재시도로 견고화.
//   재시도가 소진되면 truncated 플래그로 *시끄럽게* 실패 → 실제로 잘리는 프로젝트가 나오면 그때 청크화.

import { spawn } from "node:child_process";
import { analyzeJson } from "./clean.mjs";

/** claude -p 헤드리스 호출(STDIN 프롬프트 — Windows npm shim 회피). 청크경계 UTF-8(한국어) 손상 방지. */
export function callLLM(prompt) {
  return new Promise((res, rej) => {
    const cmd = process.env.POC_FORGE_LLM_CMD || "claude -p";
    const child = spawn(cmd, { shell: true });
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", rej);
    child.on("close", (code) => (code === 0 ? res(out) : rej(new Error(`LLM 종료코드 ${code}: ${err.slice(0, 800)}`))));
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// 잘림/파싱 실패 시 다음 시도에 붙일 피드백(간결화 유도).
const TRUNC_FEEDBACK =
  "\n\n<직전 출력이 완결되지 않았습니다(JSON 이 도중에 잘림 — truncation). " +
  "내용의 핵심은 유지하되 장황한 설명/중복을 줄여 더 간결하게, 반드시 **완결된 유효 JSON 하나만** 출력하세요. " +
  "코드펜스·산문 없이 여는 괄호부터 대응되는 닫는 괄호까지 온전하게.>";

// 가드 실패 시 다음 시도에 붙일 기본 피드백(에러 목록). S3 acceptance 루프와 동일 포맷.
const guardFeedback = (gv) =>
  `\n\n<직전 시도가 아래 가드에서 실패 — 반드시 모두 고쳐 다시 출력>\n${(gv.errors || []).map((e) => "- " + e).join("\n")}`;

/**
 * 큰 JSON 산출을 견고하게 생성: 호출 → raw 저장 → 잘림/파싱/가드 검사 → 실패 시 피드백 재시도.
 *
 * @param {object} o
 * @param {string} o.basePrompt              기본 프롬프트(피드백은 뒤에 append)
 * @param {(obj:any)=>{ok:boolean,errors?:string[],warnings?:string[]}} o.validate  가드 함수(그대로 반환됨)
 * @param {(raw:string)=>void} [o.saveRaw]   각 시도의 원본 저장(디버그/복구 aid — S3처럼 .sN-*-raw.txt)
 * @param {(obj:any)=>void} [o.stamp]        파싱 직후 obj 보정(예: o=>{o.project=project})
 * @param {(gv:object)=>string} [o.feedback] 가드 실패 → 다음 시도 피드백(기본: 에러 목록)
 * @param {number} [o.attempts=2]            최대 시도 수
 * @param {(m:string)=>void} [o.log]         진행 로그(console.error 등)
 * @param {(p:string)=>Promise<string>} [o.call]  LLM 호출(기본 callLLM; 테스트용 mock 주입)
 * @returns {Promise<{obj:any, gv:object, raw:string, attempt:number, truncated:boolean}>}
 *          gv.ok=true 면 성공. 소진 시 마지막 시도(gv.ok=false + truncated 플래그)로 반환 → 호출자가 실패 처리.
 */
export async function generateJson(o) {
  const { basePrompt, validate, saveRaw, stamp, feedback = guardFeedback, attempts = 2, log = () => {}, call = callLLM } = o;
  let fb = "";
  let last = { obj: null, gv: { ok: false, errors: ["LLM 호출 안 됨"], warnings: [] }, raw: "", attempt: 0, truncated: false };
  for (let n = 0; n < attempts; n++) {
    const raw = await call(basePrompt + fb);
    if (saveRaw) saveRaw(raw);
    const { json, truncated } = analyzeJson(raw);

    // 1) 잘림/JSON 없음 → 간결화 피드백 재시도
    if (!json || truncated) {
      last = {
        obj: null,
        gv: { ok: false, errors: [truncated ? "출력이 잘림(truncation) — 완결 JSON 아님(청크 생성이 필요한 크기일 수 있음)" : "파싱 가능한 JSON 없음"], warnings: [] },
        raw, attempt: n + 1, truncated: !!truncated,
      };
      log(`✗ ${truncated ? "잘림 감지" : "JSON 없음"}(시도 ${n + 1}/${attempts}) → 재시도`);
      fb = TRUNC_FEEDBACK;
      continue;
    }

    // 2) 파싱
    let obj;
    try { obj = JSON.parse(json); }
    catch (e) {
      last = { obj: null, gv: { ok: false, errors: ["JSON 파싱 실패: " + e.message], warnings: [] }, raw, attempt: n + 1, truncated: false };
      log(`✗ 파싱 실패(시도 ${n + 1}/${attempts}) → 재시도`);
      fb = TRUNC_FEEDBACK;
      continue;
    }
    if (stamp) stamp(obj);

    // 3) 가드
    const gv = validate(obj);
    last = { obj, gv, raw, attempt: n + 1, truncated: false };
    if (gv.ok) return last;
    log(`✗ 가드 실패(시도 ${n + 1}/${attempts}): ${(gv.errors || []).slice(0, 4).join(" · ")}${(gv.errors || []).length > 4 ? " …" : ""}`);
    fb = feedback(gv);
  }
  return last;
}
