// s1-understand · 코드 가드
// context.json 계약 검증: 스키마 유효 + 근거(evidence) 무결 + 커버리지(silent-drop 금지).
// 프롬프트가 아니라 코드로 강제한다(우회 불가).

const isStr = (v) => typeof v === "string" && v.trim().length > 0;
const isArr = Array.isArray;

/**
 * @param {any} ctx  파싱된 context 객체
 * @param {string[]} sourceFiles  sources/ 안 실제 파일명 전부(텍스트+바이너리)
 * @param {{readable?:string[]}} [opts]  readable(텍스트)로 본문을 실제로 읽은 파일 목록
 * @returns {{ok:boolean, errors:string[], warnings:string[], stats:object}}
 */
export function validateContext(ctx, sourceFiles, opts = {}) {
  const errors = [];
  const warnings = [];
  const readableSet = new Set(opts.readable || sourceFiles);

  if (!ctx || typeof ctx !== "object" || isArr(ctx)) {
    return { ok: false, errors: ["context is not a JSON object"], warnings, stats: {} };
  }

  // 1) 최상위 구조
  if (!isStr(ctx.summary)) errors.push("summary가 없거나 비었음");
  for (const k of ["facts", "entities", "glossary", "contradictions", "openQuestions", "scopeSignals", "assets"]) {
    if (!isArr(ctx[k])) errors.push(`${k}는 배열이어야 함`);
  }
  if (errors.length) return { ok: false, errors, warnings, stats: {} };

  const sourceSet = new Set(sourceFiles);
  const referenced = new Set();

  const checkSourceList = (arr, label, { required = false } = {}) => {
    if (!isArr(arr) || arr.length === 0) {
      if (required) errors.push(`${label}: 근거(sources)가 없음`);
      return;
    }
    for (const s of arr) {
      if (!isStr(s)) { errors.push(`${label}: sources 항목이 문자열이 아님`); continue; }
      if (!sourceSet.has(s)) errors.push(`${label}: 존재하지 않는 근거 파일 "${s}" (지어냄 의심)`);
      else referenced.add(s);
    }
  };

  // 2) facts — 근거 필수
  if (ctx.facts.length === 0) errors.push("facts가 비었음 (소스를 이해하지 못함)");
  ctx.facts.forEach((f, i) => {
    if (!isStr(f.claim)) errors.push(`facts[${i}].claim이 없거나 비었음`);
    if (!isStr(f.id)) warnings.push(`facts[${i}].id가 없음`);
    checkSourceList(f.sources, `facts[${i}]`, { required: true });
  });

  // 3) 나머지 컬렉션 — 근거는 있으면 검증(실존 파일이어야)
  ctx.entities.forEach((e, i) => {
    if (!isStr(e.name)) errors.push(`entities[${i}].name이 없음`);
    checkSourceList(e.sources, `entities[${i}]`);
  });
  ctx.glossary.forEach((g, i) => {
    if (!isStr(g.term)) errors.push(`glossary[${i}].term이 없음`);
    checkSourceList(g.sources, `glossary[${i}]`);
  });
  ctx.contradictions.forEach((c, i) => {
    if (c.status != null && c.status !== "open" && c.status !== "resolved")
      errors.push(`contradictions[${i}].status는 "open" 또는 "resolved"여야 함`);
    if (c.status === "resolved" && !isStr(c.resolution))
      errors.push(`contradictions[${i}]가 resolved인데 resolution(무엇으로 확정)이 없음`);
    if (!isArr(c.positions) || c.positions.length < 2) {
      errors.push(`contradictions[${i}]는 positions가 2개 이상이어야 함(양쪽 대립)`);
    } else {
      c.positions.forEach((p, j) => {
        if (!p || !isStr(p.claim)) errors.push(`contradictions[${i}].positions[${j}].claim이 없음`);
        if (p && isStr(p.source)) {
          if (!sourceSet.has(p.source)) errors.push(`contradictions[${i}].positions[${j}]: 존재하지 않는 근거 "${p.source}"`);
          else referenced.add(p.source);
        }
      });
    }
  });
  ctx.openQuestions.forEach((q, i) => {
    if (!isStr(q.item)) errors.push(`openQuestions[${i}].item이 없음`);
    if (q.status != null && q.status !== "open" && q.status !== "answered")
      errors.push(`openQuestions[${i}].status는 "open" 또는 "answered"여야 함`);
    if (q.status === "answered" && !isStr(q.answer))
      errors.push(`openQuestions[${i}]가 answered인데 answer(답변 내용)가 없음`);
    checkSourceList(q.sources, `openQuestions[${i}]`);
  });
  ctx.scopeSignals.forEach((s, i) => {
    if (!isStr(s.item)) errors.push(`scopeSignals[${i}].item이 없음`);
    checkSourceList(s.sources, `scopeSignals[${i}]`);
  });

  // 4) assets — 제공 자산 인덱스(뒤 단계 재사용). 파일당 kind/readable/useFor/summary.
  const cataloged = new Set();
  ctx.assets.forEach((a, i) => {
    if (!a || typeof a !== "object") { errors.push(`assets[${i}]가 객체가 아님`); return; }
    if (!isStr(a.file)) { errors.push(`assets[${i}].file이 없음`); return; }
    if (!sourceSet.has(a.file)) errors.push(`assets[${i}]: 존재하지 않는 파일 "${a.file}" (지어냄 의심)`);
    else cataloged.add(a.file);
    if (!isStr(a.kind)) errors.push(`assets[${i}](${a.file}).kind가 없음`);
    if (typeof a.readable !== "boolean") errors.push(`assets[${i}](${a.file}).readable는 boolean이어야 함`);
    if (!isArr(a.useFor)) errors.push(`assets[${i}](${a.file}).useFor는 배열이어야 함`);
    if (!isStr(a.summary)) warnings.push(`assets[${i}](${a.file}).summary가 비었음`);
  });

  // 5) 커버리지 — 모든 소스 파일이 assets[]에 등재되어야 함(하나도 빠짐없이 = silent-drop 금지)
  const dropped = sourceFiles.filter((f) => !cataloged.has(f));
  for (const f of dropped) {
    errors.push(`coverage: 소스 "${f}"가 assets[]에 등재되지 않음 (silent-drop 금지)`);
  }
  // (soft) readable인데 어떤 fact/모순 근거로도 안 쓰인 파일 = 이해 누락 신호
  for (const f of readableSet) {
    if (!referenced.has(f)) warnings.push(`readable "${f}"가 facts/모순 근거에 한 번도 안 쓰임 (이해 누락 가능성)`);
  }

  const stats = {
    facts: ctx.facts.length,
    entities: ctx.entities.length,
    glossary: ctx.glossary.length,
    contradictions: ctx.contradictions.length,
    contradictionsResolved: ctx.contradictions.filter((c) => c.status === "resolved").length,
    openQuestions: ctx.openQuestions.length,
    openQuestionsAnswered: ctx.openQuestions.filter((q) => q.status === "answered").length,
    scopeSignals: ctx.scopeSignals.length,
    assets: ctx.assets.length,
    coverage: `${sourceFiles.length - dropped.length}/${sourceFiles.length}`,
  };

  return { ok: errors.length === 0, errors, warnings, stats };
}

// ── --chunked 전용 가드 ───────────────────────────────────────────────────────────
// plan(skeleton) 단계 = 이해 본문 완결(summary·facts·entities·glossary·contradictions·openQuestions·scopeSignals)
//   + assets 아웃라인(파일 목록만 — 상세 kind/useFor/summary 는 다음 단계가 채움).
//   assets 아웃라인은 코드가 파일목록에서 결정적으로 주입하므로 여기선 skeleton 구조 + 파일 유일성만.
//   (조립본은 validateContext 전체 재검증 → 여긴 가볍게, 커버리지·근거 무결은 조립 시 hard.)
export function validateContextPlan(ctx) {
  const errors = [];
  const warnings = [];
  if (!ctx || typeof ctx !== "object" || isArr(ctx))
    return { ok: false, errors: ["context plan is not a JSON object"], warnings, stats: {} };

  if (!isStr(ctx.summary)) errors.push("summary가 없거나 비었음");
  for (const k of ["facts", "entities", "glossary", "contradictions", "openQuestions", "scopeSignals", "assets"])
    if (!isArr(ctx[k])) errors.push(`${k}는 배열이어야 함`);
  if (errors.length) return { ok: false, errors, warnings, stats: {} };

  if (ctx.facts.length === 0) errors.push("facts가 비었음 (소스를 이해하지 못함)");
  ctx.facts.forEach((f, i) => { if (!isStr(f.claim)) errors.push(`facts[${i}].claim이 없거나 비었음`); });

  // assets 아웃라인: 파일명 존재·유일성(상세화가 이 목록을 1:1 로 채움)
  if (ctx.assets.length === 0) errors.push("assets 아웃라인이 비었음");
  const files = new Set();
  ctx.assets.forEach((a, i) => {
    if (!a || typeof a !== "object") { errors.push(`assets[${i}]가 객체가 아님`); return; }
    if (!isStr(a.file)) { errors.push(`assets[${i}].file이 없음`); return; }
    if (files.has(a.file)) errors.push(`assets[${i}]: 중복 파일 "${a.file}"`);
    files.add(a.file);
  });

  return { ok: errors.length === 0, errors, warnings, stats: { facts: ctx.facts.length, assets: ctx.assets.length } };
}

// enrich(배치 상세화) 결과 = { assets: [풀 상세 자산] }. 배치 아웃라인 파일을 1:1 로 상세화했는지 hard.
//   opts.outlineFiles: 이 배치 아웃라인 파일명(Set 또는 배열) · opts.label
export function validateEnrichedAssets(obj, opts = {}) {
  const outlineFiles = opts.outlineFiles instanceof Set ? opts.outlineFiles : new Set(opts.outlineFiles || []);
  const label = opts.label || "batch";
  const errors = [];
  const warnings = [];
  if (!obj || typeof obj !== "object" || isArr(obj)) return { ok: false, errors: [`${label}: enrich 결과가 JSON 객체 아님`], warnings, stats: {} };
  if (!isArr(obj.assets)) return { ok: false, errors: [`${label}: assets 배열 없음`], warnings, stats: {} };

  const seen = new Set();
  obj.assets.forEach((a, i) => {
    const at = `${label}.assets[${i}](${(a && a.file) || "?"})`;
    if (!a || typeof a !== "object") { errors.push(`${at}가 객체가 아님`); return; }
    if (!isStr(a.file)) { errors.push(`${at}.file 없음`); return; }
    seen.add(a.file);
    if (outlineFiles.size && !outlineFiles.has(a.file)) errors.push(`${at}: 아웃라인에 없는 파일 "${a.file}" (배치 밖 창작 금지)`);
    if (!isStr(a.kind)) errors.push(`${at}.kind 없음/빈값 (상세화 누락)`);
    if (typeof a.readable !== "boolean") errors.push(`${at}.readable는 boolean이어야 함`);
    if (!isArr(a.useFor)) errors.push(`${at}.useFor는 배열이어야 함`);
    if (!isStr(a.summary)) errors.push(`${at}.summary 없음/빈값 (상세화 누락)`);
  });
  // 배치 완전성: 아웃라인 파일을 하나도 빠짐없이 상세화했는지(배치가 조용히 드롭 → 즉시 재시도 유도)
  const missing = [...outlineFiles].filter((f) => !seen.has(f));
  if (missing.length) errors.push(`${label}: 아웃라인 ${missing.length}개 미상세화(누락): ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? " …" : ""}`);

  return { ok: errors.length === 0, errors, warnings, stats: { count: obj.assets.length, missing: missing.length } };
}
