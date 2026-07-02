// s2-plan · 코드 가드
// spec.json 계약 검증: 계층·상세내용(granularity/깊이 강제) + 근거 무결 + acceptanceHint(test 씨앗) + 커버리지.

const isStr = (v) => typeof v === "string" && v.trim().length > 0;
const isArr = Array.isArray;
const VALID_STATUS = new Set(["confirmed", "proposed", "open"]);

/**
 * @param {any} spec
 * @param {{realFiles?:string[], readable?:string[], context?:object}} opts
 *   realFiles: sources/ 실제 파일명(근거 실존 검증) · readable: 텍스트로 읽힌 파일(커버리지) · context: S1 context.json
 */
export function validateSpec(spec, opts = {}) {
  const { realFiles = [], readable = [], context = {} } = opts;
  const errors = [];
  const warnings = [];

  if (!spec || typeof spec !== "object" || isArr(spec))
    return { ok: false, errors: ["spec is not a JSON object"], warnings, stats: {} };

  // 1) product
  const p = spec.product;
  if (!p || typeof p !== "object") errors.push("product 없음");
  else {
    for (const k of ["name", "goal", "background", "northStar"]) if (!isStr(p[k])) errors.push(`product.${k} 없거나 빈값`);
    if (!isArr(p.successCriteria) || p.successCriteria.length === 0) errors.push("product.successCriteria 비었음");
  }

  // 2) 최상위 배열/객체
  for (const k of ["personas", "scenarios", "features", "nfr", "businessRules", "openQuestions", "glossary"])
    if (!isArr(spec[k])) errors.push(`${k}는 배열이어야 함`);
  if (!spec.scope || typeof spec.scope !== "object") errors.push("scope 없음");
  if (errors.length) return { ok: false, errors, warnings, stats: {} };

  const realSet = new Set(realFiles);
  const referenced = new Set();
  const checkSources = (arr, label, { required = false } = {}) => {
    if (!isArr(arr) || arr.length === 0) {
      if (required) errors.push(`${label}: 근거(sources)가 없음`);
      return;
    }
    for (const s of arr) {
      if (!isStr(s)) { errors.push(`${label}: sources 항목이 문자열 아님`); continue; }
      if (realSet.size && !realSet.has(s)) errors.push(`${label}: 존재하지 않는 근거 "${s}" (지어냄 의심)`);
      else referenced.add(s);
    }
  };

  // 3) features — 계층 + 상세내용(깊이) + 근거 + acceptanceHint
  if (spec.features.length === 0) errors.push("features 비었음");
  const featIds = new Set();
  spec.features.forEach((f, i) => {
    const at = `features[${i}](${f.기능 || "?"})`;
    // id 존재·유일성(S3/S4가 f.id로 커버리지를 키잉 — 누락/중복이면 confirmed 기능이 silent-drop)
    if (!isStr(f.id)) errors.push(`${at}.id 없음/빈값 (하류가 id로 커버리지 키잉)`);
    else { if (featIds.has(f.id)) errors.push(`${at}: 중복 기능 id "${f.id}"`); featIds.add(f.id); }
    for (const k of ["구분", "대분류", "중분류", "기능", "상세내용"])
      if (!isStr(f[k])) errors.push(`${at}.${k} 없음/빈값 (계층·상세 강제)`);
    if (!VALID_STATUS.has(f.status)) errors.push(`${at}.status는 confirmed|proposed|open`);
    if (!isStr(f.priority)) warnings.push(`${at}.priority 없음`);
    checkSources(f.sources, at, { required: f.status === "confirmed" });
    if (isArr(f.참조데이터)) checkSources(f.참조데이터, `${at}.참조데이터`);
    // 빌드 가능한 기능(confirmed)은 검증 씨앗 필수 → S3 test 설계로 이어짐
    if (f.status === "confirmed" && (!isArr(f.acceptanceHint) || f.acceptanceHint.length === 0))
      errors.push(`${at}: acceptanceHint 최소 1 필요 (S3 test 씨앗)`);
  });

  // 4) 나머지 컬렉션 근거
  spec.personas.forEach((x, i) => { if (!isStr(x.name)) errors.push(`personas[${i}].name 없음`); checkSources(x.sources, `personas[${i}]`); });
  spec.scenarios.forEach((x, i) => { if (!isStr(x.title)) errors.push(`scenarios[${i}].title 없음`); checkSources(x.sources, `scenarios[${i}]`); });
  spec.nfr.forEach((x, i) => { if (!isStr(x.requirement)) errors.push(`nfr[${i}].requirement 없음`); checkSources(x.sources, `nfr[${i}]`); });
  spec.businessRules.forEach((x, i) => { if (!isStr(x.rule)) errors.push(`businessRules[${i}].rule 없음`); checkSources(x.sources, `businessRules[${i}]`); });
  spec.openQuestions.forEach((x, i) => { if (!isStr(x.item)) errors.push(`openQuestions[${i}].item 없음`); checkSources(x.sources, `openQuestions[${i}]`); });
  spec.glossary.forEach((x, i) => checkSources(x.sources, `glossary[${i}]`));

  // 5) 커버리지(warn) — 읽힌 소스가 spec 근거에 한 번도 안 쓰이면 반영 누락 의심
  for (const f of readable) if (!referenced.has(f)) warnings.push(`readable "${f}"가 spec 근거에 안 쓰임 (반영 누락 가능성)`);

  // 6) 승계(warn) — S1 미해결 질문이 spec.openQuestions로 안 넘어옴(부분 드롭도 탐지)
  const norm = (s) => String(s || "").replace(/\s+/g, "");
  const s1open = (context.openQuestions || []).filter((q) => q.status !== "answered");
  const specQBlob = spec.openQuestions.map((q) => norm(q.item)).join("\n");
  const dropped = s1open.filter((q) => { const key = norm(q.item).slice(0, 10); return key && !specQBlob.includes(key); });
  if (dropped.length)
    warnings.push(`S1 미해결 질문 ${dropped.length}/${s1open.length}개가 spec.openQuestions에 승계 안 됨: ${dropped.map((q) => q.item).slice(0, 3).join(" / ")}`);

  const stats = {
    features: spec.features.length,
    confirmed: spec.features.filter((f) => f.status === "confirmed").length,
    proposed: spec.features.filter((f) => f.status === "proposed").length,
    open: spec.features.filter((f) => f.status === "open").length,
    nfr: spec.nfr.length,
    businessRules: spec.businessRules.length,
    openQuestions: spec.openQuestions.length,
  };
  return { ok: errors.length === 0, errors, warnings, stats };
}

// ── --chunked 전용 가드 ─────────────────────────────────────────────────────────
// plan(아웃라인) 단계 = 뼈대 전부 + features 아웃라인(구분/대분류/중분류/기능/status/priority).
//   상세(상세내용·acceptanceHint·sources)는 아직 없음 → validateSpec 보다 가볍게. taxonomy·커버리지 고정용.
export function validateSpecPlan(spec) {
  const errors = [];
  const warnings = [];
  if (!spec || typeof spec !== "object" || isArr(spec)) return { ok: false, errors: ["spec plan is not a JSON object"], warnings, stats: {} };

  const p = spec.product;
  if (!p || typeof p !== "object") errors.push("product 없음");
  else for (const k of ["name", "goal"]) if (!isStr(p[k])) errors.push(`product.${k} 없거나 빈값`);

  for (const k of ["personas", "scenarios", "features", "nfr", "businessRules", "openQuestions", "glossary"])
    if (!isArr(spec[k])) errors.push(`${k}는 배열이어야 함`);
  if (!spec.scope || typeof spec.scope !== "object") errors.push("scope 없음");
  if (errors.length) return { ok: false, errors, warnings, stats: {} };

  if (spec.features.length === 0) errors.push("features(아웃라인) 비었음");
  const ids = new Set();
  spec.features.forEach((f, i) => {
    const at = `features[${i}](${f.기능 || "?"})`;
    if (!isStr(f.id)) errors.push(`${at}.id 없음/빈값`);
    else { if (ids.has(f.id)) errors.push(`${at}: 중복 기능 id "${f.id}"`); ids.add(f.id); }
    for (const k of ["구분", "대분류", "중분류", "기능"]) if (!isStr(f[k])) errors.push(`${at}.${k} 없음/빈값 (아웃라인 계층)`);
    if (!VALID_STATUS.has(f.status)) errors.push(`${at}.status는 confirmed|proposed|open`);
    if (!isStr(f.priority)) warnings.push(`${at}.priority 없음`);
  });

  return { ok: errors.length === 0, errors, warnings, stats: { features: spec.features.length } };
}

// enrich(그룹 상세화) 결과 = { features: [풀 상세 행] }. 그룹 아웃라인 id 를 1:1 로 상세화했는지 hard.
//   opts.outlineIds: 이 그룹 아웃라인 id 집합(Set 또는 배열) · opts.realFiles: 근거 실존 검증(선택) · opts.label
export function validateEnrichedGroup(obj, opts = {}) {
  const outlineIds = opts.outlineIds instanceof Set ? opts.outlineIds : new Set(opts.outlineIds || []);
  const realSet = new Set(opts.realFiles || []);
  const label = opts.label || "group";
  const errors = [];
  const warnings = [];
  if (!obj || typeof obj !== "object" || isArr(obj)) return { ok: false, errors: [`${label}: enrich 결과가 JSON 객체 아님`], warnings, stats: {} };
  if (!isArr(obj.features)) return { ok: false, errors: [`${label}: features 배열 없음`], warnings, stats: {} };

  const seen = new Set();
  obj.features.forEach((f, i) => {
    const at = `${label}.features[${i}](${f.기능 || "?"})`;
    if (!isStr(f.id)) { errors.push(`${at}.id 없음`); return; }
    seen.add(f.id);
    if (outlineIds.size && !outlineIds.has(f.id)) errors.push(`${at}: 아웃라인에 없는 id "${f.id}" (그룹 밖 창작 금지)`);
    for (const k of ["구분", "대분류", "중분류", "기능", "상세내용"]) if (!isStr(f[k])) errors.push(`${at}.${k} 없음/빈값 (상세화 누락)`);
    if (!VALID_STATUS.has(f.status)) errors.push(`${at}.status는 confirmed|proposed|open`);
    if (f.status === "confirmed") {
      if (!isArr(f.sources) || f.sources.length === 0) errors.push(`${at}: confirmed 인데 sources 없음`);
      else for (const s of f.sources) if (isStr(s) && realSet.size && !realSet.has(s)) errors.push(`${at}: 존재하지 않는 근거 "${s}"`);
      if (!isArr(f.acceptanceHint) || f.acceptanceHint.length === 0) errors.push(`${at}: confirmed 인데 acceptanceHint 없음(S3 test 씨앗)`);
    }
  });
  // 그룹 완전성: 아웃라인 id 를 하나도 빠짐없이 상세화했는지(배치가 조용히 드롭 → 즉시 재시도 유도)
  const missing = [...outlineIds].filter((id) => !seen.has(id));
  if (missing.length) errors.push(`${label}: 아웃라인 ${missing.length}개 미상세화(누락): ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? " …" : ""}`);

  return { ok: errors.length === 0, errors, warnings, stats: { count: obj.features.length, missing: missing.length } };
}
