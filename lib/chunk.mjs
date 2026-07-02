// lib/chunk.mjs — 스테이지 불가지 청크 생성 헬퍼 (순수 함수 · 단위검증). poc-forge 전 스테이지 공용.
//   "아웃라인-완결 → 그룹별 상세화 + jsonl 체크포인트" 의 기계 부분(S2/S3/S1 재사용):
//   그룹핑 · jsonl 파싱(손상라인 skip) · resume(완료 그룹) · 조립(id dedup·plan순서) · 커버리지 플로어(조용한 드롭 hard).
//   keyFn(그룹키)·idFn(항목 id) 을 주입해 어떤 배열에도 적용. LLM 호출/파일IO 는 각 run.mjs 가, 판정 로직은 여기.

/** items 를 keyFn 그룹으로 — 첫 등장 순서 보존. → [{key, items:[]}] */
export function groupItems(items, keyFn) {
  const order = [];
  const map = new Map();
  for (const it of items || []) {
    const k = keyFn(it);
    if (!map.has(k)) { map.set(k, { key: k, items: [] }); order.push(k); }
    map.get(k).items.push(it);
  }
  return order.map((k) => map.get(k));
}

/** jsonl 텍스트 → 객체 배열. 손상 라인(중간 사망)·빈 줄 skip(체크포인트 안전). */
export function parseJsonlLines(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* 손상 라인 skip */ }
  }
  return out;
}

/** 이미 상세화 끝난 그룹키 집합 = 그룹의 모든 아웃라인 id 가 enriched 에 존재. resume 용. */
export function doneGroupKeys(groups, enrichedRows, idFn) {
  const have = new Set((enrichedRows || []).map((r) => r && idFn(r)).filter((v) => v != null));
  const done = new Set();
  for (const g of groups) if (g.items.length && g.items.every((r) => have.has(idFn(r)))) done.add(g.key);
  return done;
}

/** 상세화 행들을 조립: id dedup(마지막 우선) + plan 순서. plan 밖 여분 id 는 뒤에 등장순 append. */
export function assembleById(planItems, enrichedRows, idFn) {
  const byId = new Map();
  for (const r of enrichedRows || []) { const id = r && idFn(r); if (id != null) byId.set(id, r); } // 마지막(최근) 우선
  const seen = new Set();
  const out = [];
  for (const p of planItems || []) { const id = idFn(p); if (byId.has(id) && !seen.has(id)) { out.push(byId.get(id)); seen.add(id); } }
  for (const r of enrichedRows || []) { const id = r && idFn(r); if (id != null && !seen.has(id)) { out.push(r); seen.add(id); } } // 여분
  return out;
}

/** 커버리지 플로어: 모든 plan(아웃라인) id 가 조립본에 존재 · 그룹별 ≥1항목. 조용한 드롭 hard 탐지(S4/S5식).
 *  labelFn(key)=에러 메시지용 그룹 라벨(기본 key 그대로). keyFn 없으면 그룹 검사 생략(id 커버만). */
export function coverageFloor(planItems, assembled, idFn, keyFn, labelFn) {
  const label = labelFn || ((k) => String(k));
  const asmIds = new Set((assembled || []).map((f) => f && idFn(f)).filter((v) => v != null));
  const dropped = (planItems || []).filter((p) => !asmIds.has(idFn(p))).map((p) => idFn(p));
  const emptyGroups = [];
  if (keyFn) {
    const asmByKey = new Map();
    for (const f of assembled || []) { const k = keyFn(f); asmByKey.set(k, (asmByKey.get(k) || 0) + 1); }
    for (const g of groupItems(planItems, keyFn)) if (!(asmByKey.get(g.key) > 0)) emptyGroups.push(g.key);
  }
  const errors = [];
  if (dropped.length) errors.push(`상세화에서 누락된 항목 ${dropped.length}개(조용한 드롭): ${dropped.slice(0, 8).join(", ")}${dropped.length > 8 ? " …" : ""}`);
  for (const k of emptyGroups) errors.push(`그룹 "${label(k)}"의 모든 항목이 누락됨`);
  return { ok: errors.length === 0, errors, dropped, emptyGroups, planCount: (planItems || []).length, assembledCount: (assembled || []).length };
}
