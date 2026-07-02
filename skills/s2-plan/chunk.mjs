// s2-plan · 청크 헬퍼 = 공용 lib/chunk.mjs 를 features(구분·대분류 그룹, id=f.id)에 바인딩한 얇은 어댑터.
//   (기계 로직은 lib/chunk.mjs 단일화 — S1/S3 도 같은 lib 재사용. 여기선 features 전용 keyFn/idFn 만.)
import { groupItems, parseJsonlLines as _parse, doneGroupKeys as _done, assembleById, coverageFloor } from "../../lib/chunk.mjs";

const GK = " "; // group key 구분자(데이터에 안 나오는 NUL)
export const groupKey = (f) => `${f.구분 || "-"}${GK}${f.대분류 || "-"}`;
const idFn = (f) => f.id;
const label = (k) => k.split(GK).join("/");

/** features(아웃라인) → (구분·대분류) 그룹. s2 코드가 g.구분/g.대분류/g.rows 를 쓰므로 그 형태로. */
export function groupFeatures(features) {
  return groupItems(features, groupKey).map((g) => ({ key: g.key, 구분: g.items[0].구분, 대분류: g.items[0].대분류, rows: g.items }));
}
export const parseJsonlLines = _parse;
export const doneGroupKeys = (groups, enrichedRows) => _done(groups.map((g) => ({ key: g.key, items: g.rows })), enrichedRows, idFn);
export const assembleFeatures = (planFeatures, enrichedRows) => assembleById(planFeatures, enrichedRows, idFn);
export const featureCoverage = (planFeatures, assembled) => coverageFloor(planFeatures, assembled, idFn, groupKey, label);
