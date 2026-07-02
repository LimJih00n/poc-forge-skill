// lib/clean.mjs — LLM 출력 공용 정리 (poc-forge 전 스테이지 재사용)
//   claude -p 는 코드/JSON/문서 앞뒤에 산문 프리앰블·꼬리말("Here is the file:", "위가 …전문입니다",
//   "쓰기 권한을 허용해 주세요" 등)을 붙이는 경향이 있다 → 순수 산출만 남긴다.
//   세 변형: cleanCodeOutput(ts/tsx) · cleanMarkdownDoc(md) · extractJson(견고).
//   (이전엔 s3 extractJson/stripWrappingFence, s4 clean.mjs 가 제각각 → 산문 오염·JSON 취약이 재발. 여기서 단일화.)

const CODE_START = /^\s*(import\b|export\b|["']use (client|server)["']|\/\/|\/\*|\*|const\b|let\b|var\b|type\b|interface\b|function\b|async\s+function\b|class\b|enum\b|declare\b|@\w|<)/;

/** 가장 큰 코드펜스 내부만(없으면 감싸는 단일 펜스 제거). 펜스가 없으면 원문 trim. */
export function insideLargestFence(input) {
  const t = String(input).trim();
  const fences = [...t.matchAll(/```[a-z]*\s*\n([\s\S]*?)\n```/gi)].map((m) => m[1]);
  if (fences.length) return fences.sort((a, b) => b.length - a.length)[0].trim();
  return t.replace(/^```[a-z]*\s*\n/i, "").replace(/\n```\s*$/i, "").trim();
}

/** TS/TSX 등 코드 파일 정리(프리앰블/꼬리말 산문 제거). s4 codegen용. */
export function cleanCodeOutput(s) {
  const t = insideLargestFence(s);
  const lines = t.split(/\r?\n/);
  // 앞: 첫 코드 시작 토큰 라인부터
  const firstCode = lines.findIndex((l) => CODE_START.test(l));
  if (firstCode > 0) lines.splice(0, firstCode);
  // 뒤: 마지막 줄이 *명백한* 산문/펜스일 때만(정상 코드 오절단 방지)
  const proseLike = (l) =>
    /^(this |the |here |note[: ]|위 |참고|이 (파일|코드)|파일로|```|i've |i have |the file|위가 )/i.test(l) ||
    /^[A-Z][^=(){};<>]*[.:]$/.test(l);
  let end = lines.length;
  while (end > 0) {
    const l = lines[end - 1].trim();
    if (!l) { end--; continue; }
    if (proseLike(l)) { end--; continue; }
    break;
  }
  if (end < lines.length) lines.length = end;
  return lines.join("\n").trim() + "\n";
}

/** 마크다운 문서 정리(dev-doc 등): 첫 헤딩 앞 산문 + 파일쓰기 관련 꼬리말 제거. 헤딩 없으면 원문 보존.
 *  ★ 내부 코드블록(디렉토리 트리·샘플)은 보존 — 문서 *전체*를 감싼 단일 펜스만 벗긴다(insideLargestFence 쓰면 안 됨). */
export function cleanMarkdownDoc(s) {
  let t = String(s).trim();
  const whole = t.match(/^```[a-z]*\s*\n([\s\S]*)\n```$/i); // 전체가 한 펜스일 때만 언랩
  if (whole) t = whole[1].trim();
  const lines = t.split(/\r?\n/);
  const firstHead = lines.findIndex((l) => /^#{1,6}\s/.test(l));
  if (firstHead > 0) { lines.splice(0, firstHead); t = lines.join("\n"); }
  // 꼬리말(파일 쓰기/권한/저장 관련 메타 산문)만 보수적으로 제거
  const tail = [
    /\n+위가 [`'"]?[\w.\-]*(?:dev-doc|문서|전문|스펙)[\s\S]*$/i,
    /\n+[^\n]*(?:쓰기 권한|저장하겠습니다|저장할까요|바로 저장|permission grant|the file write)[\s\S]*$/i,
  ];
  for (const re of tail) t = t.replace(re, "");
  return t.trim();
}

/** s에서 open('{'/'[') 매칭 균형 슬라이스(문자열/이스케이프 인식). 실패 null. */
function balancedSlice(s, start) {
  const open = s[start], close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; }
    else if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

/**
 * src 를 한 번 훑어: (a) JSON.parse 성공하는 **가장 긴** 균형 슬라이스(best) + (b) 잘림(truncation) 신호.
 *   - best: 산문 프리앰블의 `{id}` 같은 가짜 중괄호(파싱 실패)는 건너뛰고, 매칭 영역은 점프 → 사실상 O(n).
 *   - sawUnclosed: 구조 여는 괄호가 EOF까지 안 닫힘(balancedSlice=null) = 출력이 JSON 도중 잘린 신호.
 *     (★ 여기서 break 하면 안 됨 — 잘린 바깥 구조 *안쪽*의 완결 조각을 계속 건져야 extractJson 살베지가 유지됨.)
 */
function scanJson(src) {
  let best = null, bestStart = -1, i = 0, firstUnclosed = -1;
  while (i < src.length) {
    const c = src[i];
    if (c === "{" || c === "[") {
      const slice = balancedSlice(src, i);
      if (slice === null) { if (firstUnclosed === -1) firstUnclosed = i; i++; continue; } // EOF까지 미종료 = 잘림 후보(안쪽 조각은 계속 스캔)
      try { JSON.parse(slice); if (!best || slice.length > best.length) { best = slice; bestStart = i; } i += slice.length; continue; }
      catch { /* 이 시작점은 유효 JSON 아님(가짜 중괄호) — 다음 문자로 */ }
    }
    i++;
  }
  return { best, bestStart, firstUnclosed };
}

/**
 * LLM 출력에서 JSON을 견고하게 추출.
 *   - 첫 '{' 강제매칭이 아니라: 펜스 내부 우선 → 파싱 성공하는 **가장 긴** 균형 객체/배열.
 *   - 산문 프리앰블에 `{id}` 같은 가짜 중괄호가 있어도 건너뛴다(파싱 실패 → 다음 후보).
 */
export function extractJson(text) {
  const trimmed = String(text).trim();
  const fence = insideLargestFence(trimmed);
  const best = (fence !== trimmed ? scanJson(fence).best : null) || scanJson(trimmed).best;
  if (!best) throw new Error("LLM 출력에서 파싱 가능한 JSON 객체/배열을 못 찾음");
  return best;
}

/**
 * LLM JSON 출력 분석 = {json, truncated}. generateJson 재시도 판단용.
 *   - json: extractJson 과 동일한 최장 파싱가능 슬라이스(없으면 null).
 *   - truncated: **가장 먼저(바깥에서) 시작된 구조가 EOF까지 안 닫힘** = 출력이 JSON 도중 잘림.
 *     위치 규칙(비율 휴리스틱 아님): 미종료 시작점(firstUnclosed)이 살베지한 조각(best)의 시작보다 *앞*이면,
 *     그 조각은 잘린 바깥 구조의 *안쪽* 파편 → 잘림. (완결 JSON 뒤에 쓰레기 `{…`가 잘려 붙은 경우는
 *     firstUnclosed 가 best 뒤에 오므로 완결로 간주. 산문 `{id}` 는 balancedSlice 가 non-null 이라 미종료 아님.)
 */
export function analyzeJson(text) {
  const trimmed = String(text).trim();
  const fence = insideLargestFence(trimmed);
  const src = fence !== trimmed ? fence : trimmed;
  const { best, bestStart, firstUnclosed } = scanJson(src);
  const truncated = firstUnclosed !== -1 && (best === null || firstUnclosed < bestStart);
  return { json: best, truncated };
}

/** 자식 프로세스 stdout/stderr 청크경계 UTF-8 손상 방지(한국어 멀티바이트). callLLM 공용. */
export function setUtf8(child) {
  try { child.stdout && child.stdout.setEncoding("utf8"); } catch {}
  try { child.stderr && child.stderr.setEncoding("utf8"); } catch {}
  return child;
}
