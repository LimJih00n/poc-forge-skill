// s1-understand · 청크 헬퍼 = 공용 lib/chunk.mjs 를 assets(파일 배치 그룹, id=a.file)에 바인딩한 얇은 어댑터.
//   S1의 지배적·결정적 배열 = assets(소스 파일마다 1개, 파일목록이 사전에 확정 → 코드가 아웃라인을
//   결정적으로 구성 = LLM이 파일을 드롭할 수 없음 → 커버리지 원천 보장). 자연 분류가 없어 그룹키 = 파일 배치(index/N).
//   (기계 로직은 lib/chunk.mjs 단일화 — S2와 동일 lib 재사용. 여기선 assets 전용 배치/idFn 만.)
import { parseJsonlLines as _parse, doneGroupKeys as _done, assembleById, coverageFloor } from "../../lib/chunk.mjs";

export const ASSETS_PER_BATCH = 4; // 상세화 배치 크기(파일 N개씩) — 작아서 상세히·안 잘림
const idFn = (a) => a && a.file;

/** 아웃라인 assets(파일순) → 파일 배치 그룹. [{key:"batch-1", items:[outlineAsset]}] (위치 기반, 결정적). */
export function groupAssets(outlineAssets, n = ASSETS_PER_BATCH) {
  const groups = [];
  const items = outlineAssets || [];
  for (let i = 0; i < items.length; i += n)
    groups.push({ key: `batch-${Math.floor(i / n) + 1}`, items: items.slice(i, i + n) });
  return groups;
}
export const parseJsonlLines = _parse;
export const doneGroupKeys = (groups, enrichedRows) => _done(groups, enrichedRows, idFn);
export const assembleAssets = (outlineAssets, enrichedRows) => assembleById(outlineAssets, enrichedRows, idFn);

/** 커버리지 플로어: 모든 아웃라인 파일이 상세화본에 존재(조용한 드롭 hard) · 배치별 ≥1.
 *  배치키는 위치 기반이라 file→배치 맵으로 keyFn 구성(아웃라인·조립본 양쪽에서 file 로 해석됨). */
export function assetsCoverage(outlineAssets, assembled, n = ASSETS_PER_BATCH) {
  const batchOf = new Map();
  (outlineAssets || []).forEach((a, i) => batchOf.set(a.file, `batch-${Math.floor(i / n) + 1}`));
  const keyFn = (a) => batchOf.get(a && a.file) || "batch-?";
  return coverageFloor(outlineAssets, assembled, idFn, keyFn, (k) => k);
}
