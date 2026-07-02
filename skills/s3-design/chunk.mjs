// s3-design · 청크 헬퍼 = 공용 lib/chunk.mjs 를 S3 4개 산출의 지배적 배열에 바인딩한 얇은 어댑터.
//   (기계 로직은 lib/chunk.mjs 단일화 — S2 와 같은 lib 재사용. 여기선 각 배열 전용 keyFn/idFn/그룹핑만.)
//   각 산출은 { arrayKey, idFn, group, done, assemble, coverage, label } 번들을 노출 → run.mjs 의
//   범용 청크 스테이지 러너(genChunkedStage)가 그대로 소비.
import { groupItems, parseJsonlLines as _parse, doneGroupKeys as _done, assembleById, coverageFloor } from "../../lib/chunk.mjs";

export const parseJsonlLines = _parse;

// keyFn(그룹핑)·idFn(항목 id)·labelFn(로그 라벨)로 청크 번들 생성. keyFn 을 아이템에 적용 가능한 산출용.
function makeChunk(arrayKey, keyFn, idFn, labelFn) {
  const label = labelFn || ((k) => String(k));
  return {
    arrayKey,
    idFn,
    label,
    group: (items) => groupItems(items, keyFn).map((g) => ({ key: g.key, label: label(g.key), items: g.items })),
    done: (groups, rows) => _done(groups.map((g) => ({ key: g.key, items: g.items })), rows, idFn),
    assemble: (planItems, rows) => assembleById(planItems, rows, idFn),
    coverage: (planItems, assembled) => coverageFloor(planItems, assembled, idFn, keyFn, label),
  };
}

// ── (a) page-spec.pages — 그룹키 = url 첫 세그먼트(/admin/x→admin, /equipment→equipment) ──────
export const pageSection = (p) => {
  const m = String(p && p.url || "").match(/^\/([^/?#]+)/);
  return m ? m[1] : "(기타)"; // 비-라우트(전역/배치 등)는 한 버킷으로
};
export const pageSpecChunk = makeChunk("pages", pageSection, (p) => p.id, (k) => `섹션 /${k === "(기타)" ? "" : k}`);

// ── (b) server-spec.endpoints — 그룹키 = /api/ 뒤 리소스 세그먼트, 없으면 method ─────────────
export const endpointResource = (e) => {
  const path = String(e && e.path || "");
  const m = path.match(/\/api\/([^/?#]+)/);
  if (m) return m[1];
  return String(e && e.method || "misc").toLowerCase();
};
export const serverChunk = makeChunk("endpoints", endpointResource, (e) => e.id, (k) => `리소스 ${k}`);

// ── (c) acceptance.tests — 그룹키 = test.page(실존 page-spec id) ──────────────────────────────
export const testPage = (t) => String((t && t.page) || "(무페이지)");
export const acceptanceChunk = makeChunk("tests", testPage, (t) => t.id, (k) => `페이지 ${k}`);

// ── (d) schema.tables — 자연 그룹키 없음 → N개씩 배치(index/BATCH). coverage 는 id(테이블명)만 ──
export const TABLE_BATCH = 6;
const tableId = (t) => t.name;
export const schemaChunk = {
  arrayKey: "tables",
  idFn: tableId,
  label: (k) => String(k),
  // 배치 그룹핑(위치 기반) — groupItems(keyFn) 은 아이템에 위치정보가 없어 못 씀. 배열을 잘라 배치화.
  group: (tables) => {
    const groups = [];
    for (let i = 0; i < (tables || []).length; i += TABLE_BATCH) {
      const n = groups.length + 1;
      groups.push({ key: `batch-${n}`, label: `테이블 배치 ${n}`, items: tables.slice(i, i + TABLE_BATCH) });
    }
    return groups;
  },
  done: (groups, rows) => _done(groups.map((g) => ({ key: g.key, items: g.items })), rows, tableId),
  assemble: (planItems, rows) => assembleById(planItems, rows, tableId),
  // keyFn 없이 호출 → 조용한 드롭(테이블명 누락)만 hard 검사(배치 경계는 무의미하므로 그룹검사 생략).
  coverage: (planItems, assembled) => coverageFloor(planItems, assembled, tableId, undefined, undefined),
};
