// s3-design · 코드 가드
// S3 계약 검증(4종). 모두 "커버리지 = silent-drop 방지"를 코드로 강제한다.
//   phase ui   : validatePageSpec  — confirmed 기능 100% → 페이지 매핑 · renderScreen엔 gpt2Prompt · 근거(media_refs) 무결
//   phase design: validateSchema / validateServerSpec / validateAcceptance
//     - schema : 테이블·컬럼·타입 · relations가 실존 테이블 참조
//     - server : endpoint.tables ⊂ 실존 테이블 · endpoint.features ⊂ 실존 기능(지어냄 방지)
//     - accept.: confirmed 기능마다 테스트 ≥1 (test=바닥) · assert가 selectors data-testid 참조

const isStr = (v) => typeof v === "string" && v.trim().length > 0;
const isArr = Array.isArray;
const isObj = (v) => v && typeof v === "object" && !isArr(v);

// spec.json에서 기능 id 집합 뽑기(교차검증용)
export function featureIndex(spec) {
  const all = new Set(), confirmed = new Set(), proposed = new Set();
  for (const f of spec?.features || []) {
    if (isStr(f.id)) { all.add(f.id); if (f.status === "confirmed") confirmed.add(f.id); else if (f.status === "proposed") proposed.add(f.id); }
  }
  return { all, confirmed, proposed };
}

// spec.json businessRules id 집합(정책 커버리지용). status 없거나 open 아니면 confirmed로 취급.
export function ruleIndex(spec) {
  const all = new Set(), confirmed = new Set();
  for (const r of spec?.businessRules || []) {
    if (isStr(r.id)) { all.add(r.id); if (r.status !== "open") confirmed.add(r.id); }
  }
  return { all, confirmed };
}

// ── phase ui: page-spec.json ────────────────────────────────────────────────
/**
 * @param {any} pageSpec
 * @param {{spec:object, realFiles?:string[]}} opts  spec=S2 spec.json · realFiles=sources/ 실제 파일(media_refs 무결)
 */
export function validatePageSpec(pageSpec, { spec = {}, realFiles = [] } = {}) {
  const errors = [], warnings = [];
  if (!isObj(pageSpec)) return { ok: false, errors: ["page-spec is not a JSON object"], warnings, stats: {} };
  if (!isArr(pageSpec.ia)) errors.push("ia는 배열이어야 함");
  if (!isArr(pageSpec.pages) || pageSpec.pages.length === 0) errors.push("pages 비었음");
  if (errors.length) return { ok: false, errors, warnings, stats: {} };

  const { all: specIds, confirmed, proposed } = featureIndex(spec);
  const realSet = new Set(realFiles);
  const covered = new Set();          // 어느 페이지에든 실린 기능
  const renderCovered = new Set();    // 실제 화면(renderScreen:true)에 실린 기능(비-렌더 우회 탐지용)
  const pageIds = new Set(), pageUrls = new Set();

  pageSpec.pages.forEach((p, i) => {
    const at = `pages[${i}](${p.name || p.id || "?"})`;
    for (const k of ["id", "name", "url", "purpose"]) if (!isStr(p[k])) errors.push(`${at}.${k} 없음/빈값`);
    if (isStr(p.id)) { if (pageIds.has(p.id)) errors.push(`${at}: 중복 페이지 id ${p.id}`); pageIds.add(p.id); }
    // 실제 화면(renderScreen)만 라우트(/) 필수 — 전역/배치 같은 비화면 항목은 (global)/(backend) 라벨 허용
    if (isStr(p.url)) {
      if (p.renderScreen === true) {
        if (!p.url.startsWith("/")) errors.push(`${at}.url은 /로 시작해야 함(실 화면)`);
        // 동적 세그먼트는 Next `[param]` 형식이어야(S4 pageToFile이 그대로 매핑) — {param}/:param 금지
        else if (/[{}]|\/:/.test(p.url)) errors.push(`${at}.url "${p.url}" 동적 세그먼트는 Next [param] 형식이어야(예: /x/[id]) — {param}/:param 금지`);
      }
      pageUrls.add(p.url);
    }
    if (!isArr(p.roles) || p.roles.length === 0) errors.push(`${at}.roles 비었음(접근 권한 필수)`);
    if (!isArr(p.states) || p.states.length === 0) errors.push(`${at}.states 비었음(기본/로딩/빈상태/에러 등 필수)`);
    if (typeof p.renderScreen !== "boolean") errors.push(`${at}.renderScreen(bool) 없음`);
    // renderScreen=true(실제 UI 화면)면 gpt2 프롬프트 필수 — 전 화면 렌더 대상
    if (p.renderScreen === true && !isStr(p.gpt2Prompt)) errors.push(`${at}: renderScreen면 gpt2Prompt 필수`);
    // 기능 매핑(커버리지 링크) — 지어낸 기능 id 금지
    if (!isArr(p.features)) errors.push(`${at}.features는 배열이어야 함`);
    else for (const fid of p.features) {
      if (specIds.size && !specIds.has(fid)) errors.push(`${at}: 존재하지 않는 기능 id "${fid}" (지어냄 의심)`);
      else { covered.add(fid); if (p.renderScreen === true) renderCovered.add(fid); }
    }
    // media_refs = S1 자산 참조 무결
    if (isArr(p.media_refs)) for (const m of p.media_refs)
      if (realSet.size && !realSet.has(m)) errors.push(`${at}.media_refs "${m}" 실존 파일 아님`);
    // actions는 mutates 플래그로 서버 역산 근거
    if (isArr(p.actions)) p.actions.forEach((a, j) => {
      if (!isStr(a.label)) errors.push(`${at}.actions[${j}].label 없음`);
    });
  });

  // ★ 커버리지: confirmed 기능은 하나도 빠짐없이 어떤 페이지엔가 실려야 함(silent-drop 금지)
  const uncovered = [...confirmed].filter((id) => !covered.has(id));
  if (uncovered.length) errors.push(`confirmed 기능이 어느 페이지에도 안 실림(커버리지): ${uncovered.join(", ")}`);
  // 화면-first 우회 방지: confirmed 기능이 실화면(renderScreen) 없이 (backend)/(global) 페이지로만 커버되면 표면화(의도적 배치인지 게이트에서 확인)
  const onlyNonRender = [...confirmed].filter((id) => covered.has(id) && !renderCovered.has(id));
  if (onlyNonRender.length) warnings.push(`confirmed 기능이 실화면 없이 비-렌더 페이지로만 커버됨(배치 의도 확인): ${onlyNonRender.join(", ")}`);
  // proposed 기능도 조용히 빠지지 않게 표면화(warn)
  const uncoveredProposed = [...proposed].filter((id) => !covered.has(id));
  if (uncoveredProposed.length) warnings.push(`proposed 기능이 어느 화면에도 안 실림(누락 가능): ${uncoveredProposed.join(", ")}`);

  // ia url이 실제 페이지를 가리키는지(warn)
  for (const sec of pageSpec.ia || [])
    for (const it of sec.items || [])
      if (isStr(it.url) && !pageUrls.has(it.url)) warnings.push(`ia "${it.label || it.url}" url이 어느 페이지에도 없음`);

  // ★ 사용자 플로우(UX 여정) — 화면 전이가 실존 화면을 밟는지 + S2 시나리오 커버리지
  const flowIds = new Set();
  const coveredScenarios = new Set();
  if (!isArr(pageSpec.flows) || pageSpec.flows.length === 0) {
    errors.push("flows 비었음(사용자 플로우/여정 필수 — UX 설계)");
  } else {
    pageSpec.flows.forEach((fl, i) => {
      const at = `flows[${i}](${fl.name || fl.id || "?"})`;
      if (!isStr(fl.id)) errors.push(`${at}.id 없음`);
      else { if (flowIds.has(fl.id)) errors.push(`${at}: 중복 flow id`); flowIds.add(fl.id); }
      if (!isStr(fl.name)) errors.push(`${at}.name 없음`);
      if (isStr(fl.scenario)) coveredScenarios.add(fl.scenario);
      if (!isArr(fl.steps) || fl.steps.length === 0) errors.push(`${at}.steps 비었음`);
      else fl.steps.forEach((st, j) => {
        const sat = `${at}.steps[${j}]`;
        if (!isStr(st.page)) errors.push(`${sat}.page 없음`);
        else if (pageIds.size && !pageIds.has(st.page)) errors.push(`${sat}.page "${st.page}" 실존 화면 아님`);
        if (st.to != null && isStr(st.to) && pageIds.size && !pageIds.has(st.to) && !/^(end|외부|external|종료|끝)/i.test(st.to))
          errors.push(`${sat}.to "${st.to}" 실존 화면 아님`);
      });
    });
    // S2 시나리오가 어느 플로우에도 매핑 안 되면 표면화(warn)
    const scenarioIds = (spec.scenarios || []).map((s) => s.id).filter((x) => isStr(x));
    const uncoveredSc = scenarioIds.filter((id) => !coveredScenarios.has(id));
    if (uncoveredSc.length) warnings.push(`S2 시나리오가 어느 플로우에도 매핑 안 됨: ${uncoveredSc.join(", ")}`);
  }

  const renderCount = pageSpec.pages.filter((p) => p.renderScreen === true).length;
  const stats = { pages: pageSpec.pages.length, renderScreens: renderCount, coveredFeatures: covered.size, confirmed: confirmed.size, flows: flowIds.size };
  return { ok: errors.length === 0, errors, warnings, stats };
}

// ── phase design: schema.json ───────────────────────────────────────────────
export function validateSchema(schema) {
  const errors = [], warnings = [];
  if (!isObj(schema)) return { ok: false, errors: ["schema is not a JSON object"], warnings, stats: {} };
  if (!isArr(schema.tables) || schema.tables.length === 0) errors.push("tables 비었음");
  if (!isArr(schema.relations)) errors.push("relations는 배열이어야 함");
  if (errors.length) return { ok: false, errors, warnings, stats: {} };

  const names = new Set();
  schema.tables.forEach((t, i) => {
    const at = `tables[${i}](${t.name || "?"})`;
    if (!isStr(t.name)) errors.push(`${at}.name 없음`);
    else { if (names.has(t.name)) errors.push(`${at}: 중복 테이블명`); names.add(t.name); }
    if (!isArr(t.columns) || t.columns.length === 0) errors.push(`${at}.columns 비었음`);
    else t.columns.forEach((c, j) => {
      if (!isStr(c.name)) errors.push(`${at}.columns[${j}].name 없음`);
      if (!isStr(c.type)) errors.push(`${at}.columns[${j}].type 없음`);
    });
  });
  (schema.relations || []).forEach((r, i) => {
    for (const k of ["from", "to"]) if (!isStr(r[k])) errors.push(`relations[${i}].${k} 없음`);
    for (const k of ["from", "to"]) {
      const tbl = String(r[k] || "").split(".")[0]; // "table" 또는 "table.col" 허용
      if (names.size && isStr(r[k]) && !names.has(tbl)) errors.push(`relations[${i}].${k} "${r[k]}" 실존 테이블 아님`);
    }
  });

  const stats = { tables: schema.tables.length, columns: schema.tables.reduce((n, t) => n + (t.columns?.length || 0), 0), relations: (schema.relations || []).length };
  return { ok: errors.length === 0, errors, warnings, stats, tableNames: names };
}

// ── phase design: server-spec.json ──────────────────────────────────────────
/** @param {{spec:object, tableNames:Set<string>, pageSpec:object}} opts */
export function validateServerSpec(serverSpec, { spec = {}, tableNames = new Set(), pageSpec = {} } = {}) {
  const errors = [], warnings = [];
  if (!isObj(serverSpec)) return { ok: false, errors: ["server-spec is not a JSON object"], warnings, stats: {} };
  if (!isArr(serverSpec.endpoints) || serverSpec.endpoints.length === 0) errors.push("endpoints 비었음");
  if (errors.length) return { ok: false, errors, warnings, stats: {} };

  const { all: specIds } = featureIndex(spec);
  const { all: ruleIds } = ruleIndex(spec);
  const paths = new Set();
  serverSpec.endpoints.forEach((e, i) => {
    const at = `endpoints[${i}](${e.path || e.id || "?"})`;
    if (!isStr(e.method)) errors.push(`${at}.method 없음`);
    if (!isStr(e.path)) errors.push(`${at}.path 없음`);
    if (isStr(e.method) && isStr(e.path)) { const k = `${e.method} ${e.path}`; if (paths.has(k)) warnings.push(`${at}: 중복 ${k}`); paths.add(k); }
    if (!isStr(e.logic)) errors.push(`${at}.logic 없음(서버 처리 설명 필수)`);
    if (!isArr(e.roles) || e.roles.length === 0) warnings.push(`${at}.roles 비었음`);
    // endpoint.tables ⊂ 실존 테이블(스키마 정합)
    if (isArr(e.tables)) for (const t of e.tables)
      if (tableNames.size && !tableNames.has(String(t).split(".")[0])) errors.push(`${at}.tables "${t}" 스키마에 없음`);
    // endpoint.features ⊂ 실존 기능(지어냄 방지)
    if (isArr(e.features)) for (const f of e.features)
      if (specIds.size && !specIds.has(f)) errors.push(`${at}.features "${f}" 존재하지 않는 기능 id`);
    // endpoint.rules ⊂ 실존 businessRule(정책을 서버 로직으로 강제 — 지어냄 방지)
    if (isArr(e.rules)) for (const r of e.rules)
      if (ruleIds.size && !ruleIds.has(r)) errors.push(`${at}.rules "${r}" 존재하지 않는 businessRule id`);
  });
  if (!isArr(serverSpec.dataFlow) || serverSpec.dataFlow.length === 0) warnings.push("dataFlow 비었음(주요 흐름 서술 권장)");

  // ── modules[] (도메인 모듈 분해) — S4가 레이어 B(lib/*.ts)를 여기서 결정적 도출(도메인 불가지). 필수.
  const modFiles = new Set();
  if (!isArr(serverSpec.modules) || serverSpec.modules.length === 0) {
    errors.push("modules[] 비었음 — 도메인 로직 lib 모듈 분해 필수(개발 S4가 이걸로 lib/*.ts 생성; 하드코딩 제거)");
  } else {
    serverSpec.modules.forEach((m, i) => {
      const at = `modules[${i}](${(m && m.file) || "?"})`;
      const f = String((m && m.file) || "").replace(/^\.?[\\/]/, "");
      if (!/^lib\/[\w.\-/]+\.ts$/.test(f)) errors.push(`${at}.file은 "lib/<이름>.ts" 형식이어야 함`);
      else { if (modFiles.has(f)) errors.push(`${at}: 중복 모듈 파일 ${f}`); modFiles.add(f); }
      if (!isStr(m && m.purpose)) errors.push(`${at}.purpose 없음`);
    });
  }

  // ── 변경 액션 커버리지(page-spec mutates:true → 쓰기 엔드포인트) — silent-drop 방지(prompt 규칙1을 코드로 강제)
  const WRITE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
  const writeEndpoints = serverSpec.endpoints.filter((e) => WRITE.has(String(e.method || "").toUpperCase())).length;
  let mutateActions = 0;
  for (const p of pageSpec?.pages || [])
    for (const a of p.actions || []) if (a && a.mutates === true) mutateActions++;
  if (mutateActions > 0 && writeEndpoints === 0)
    errors.push(`page-spec 변경 액션(mutates:true) ${mutateActions}개 있는데 쓰기 엔드포인트(POST/PATCH/PUT/DELETE) 0개 — 변경 로직 누락`);
  else if (mutateActions > writeEndpoints)
    warnings.push(`변경 액션 ${mutateActions}개 > 쓰기 엔드포인트 ${writeEndpoints}개 — 일부 변경이 엔드포인트 없이 누락됐을 수 있음(확인)`);

  const stats = { endpoints: serverSpec.endpoints.length, dataFlow: (serverSpec.dataFlow || []).length, modules: modFiles.size, mutateActions, writeEndpoints };
  return { ok: errors.length === 0, errors, warnings, stats };
}

// ── phase design: acceptance.json ───────────────────────────────────────────
/** @param {{spec:object, pageSpec:object, serverSpec:object}} opts — 바닥 커버리지 + 롤/페이지/셀렉터 계약 + 정책기능 적대 강제 */
export function validateAcceptance(acceptance, { spec = {}, pageSpec = {}, serverSpec = {} } = {}) {
  const errors = [], warnings = [];
  if (!isObj(acceptance)) return { ok: false, errors: ["acceptance is not a JSON object"], warnings, stats: {} };
  if (!isObj(acceptance.selectors)) errors.push("selectors(객체) 없음 (셀렉터 계약)");
  if (!isArr(acceptance.tests) || acceptance.tests.length === 0) errors.push("tests 비었음");
  if (errors.length) return { ok: false, errors, warnings, stats: {} };

  const { all: specIds, confirmed } = featureIndex(spec);
  const selectorVals = new Set(Object.values(acceptance.selectors || {}).map(String));
  const pageIds = new Set((pageSpec.pages || []).map((p) => p.id).filter(isStr));
  const anonRoles = new Set(["미인증", "익명", "비로그인", "anon", "anonymous", "guest", "게스트"]);
  const validRoles = new Set();
  for (const p of pageSpec.pages || []) for (const r of p.roles || []) if (isStr(r)) validRoles.add(r);
  const testedFeatures = new Set();
  const advFeatures = new Set();
  const ids = new Set();
  const rolesSeen = new Set();

  acceptance.tests.forEach((t, i) => {
    const at = `tests[${i}](${t.id || "?"})`;
    if (!isStr(t.id)) errors.push(`${at}.id 없음`);
    else { if (ids.has(t.id)) errors.push(`${at}: 중복 test id`); ids.add(t.id); }
    if (!isStr(t.feature_id)) errors.push(`${at}.feature_id 없음`);
    else if (specIds.size && !specIds.has(t.feature_id)) errors.push(`${at}.feature_id "${t.feature_id}" 존재하지 않는 기능`);
    else { testedFeatures.add(t.feature_id); if (t.type === "adversarial") advFeatures.add(t.feature_id); }
    // page ∈ 실존 page-spec id (프롬프트 규칙: page는 실존 화면 id)
    if (isStr(t.page) && pageIds.size && !pageIds.has(t.page)) errors.push(`${at}.page "${t.page}" 실존 page-spec id 아님`);
    // setup.role(기계가독) 필수 — S5가 이 값으로 롤별 로그인(산문 note 파싱 금지)
    if (!isObj(t.setup)) errors.push(`${at}.setup(객체) 없음`);
    else if (!isStr(t.setup.role)) errors.push(`${at}.setup.role 없음(로그인 롤 문자열 필수 — 앱 롤 또는 "미인증")`);
    else { rolesSeen.add(t.setup.role);
      if (validRoles.size && !validRoles.has(t.setup.role) && !anonRoles.has(t.setup.role))
        warnings.push(`${at}.setup.role "${t.setup.role}" 화면설계 roles에 없음(오타 의심)`); }
    if (!isArr(t.steps) || t.steps.length === 0) errors.push(`${at}.steps 비었음`);
    if (!isArr(t.assert) || t.assert.length === 0) errors.push(`${at}.assert 비었음`);
    else t.assert.forEach((a, j) => {
      if (!isStr(a.kind)) errors.push(`${at}.assert[${j}].kind 없음`);
      // ★ 셀렉터 계약(무결): assert.target의 data-testid는 반드시 selectors에 등재(S4가 이 목록으로 부여, S5가 검수) — hard
      const tgt = String(a.target || "");
      if (/data-testid/.test(tgt) && selectorVals.size && !selectorVals.has(tgt))
        errors.push(`${at}.assert[${j}] target "${tgt}" selectors에 미등재(셀렉터 계약 위반)`);
    });
  });

  // ★ 바닥 커버리지: confirmed 기능은 하나도 빠짐없이 테스트 ≥1 (teaching-to-test 아님 — 최소 바닥)
  const uncovered = [...confirmed].filter((id) => !testedFeatures.has(id));
  if (uncovered.length) errors.push(`confirmed 기능에 테스트 없음(바닥 커버리지): ${uncovered.join(", ")}`);
  // ★ 정책을 강제하는 각 **변경(WRITE)+rules 엔드포인트**는 적대 테스트 ≥1 필수(hard) — 한도초과·권한위반이 진짜 거부되는지.
  //   그 엔드포인트의 features 중 하나라도 적대 테스트가 있으면 커버. (조회·detection형 rule은 제외 = 과잉/불만족 방지)
  const WRITE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
  const uncoveredWriteEps = [];
  for (const e of serverSpec.endpoints || []) {
    if (!WRITE.has(String(e.method || "").toUpperCase()) || !isArr(e.rules) || !e.rules.length) continue;
    const feats = (e.features || []).filter(isStr);
    if (feats.length && !feats.some((f) => advFeatures.has(f))) uncoveredWriteEps.push(e.id || `${e.method} ${e.path}`);
  }
  if (uncoveredWriteEps.length) errors.push(`정책 변경(WRITE) 엔드포인트에 적대 테스트 없음(우회 방지 hard): ${uncoveredWriteEps.join(", ")}`);
  // 그 외 confirmed 기능의 적대 테스트는 권장(warn)
  const noAdv = [...confirmed].filter((id) => testedFeatures.has(id) && !advFeatures.has(id));
  if (noAdv.length) warnings.push(`적대/엣지 테스트 없는 confirmed 기능 ${noAdv.length}개 (우회 방지 권장)`);

  const stats = {
    tests: acceptance.tests.length,
    normal: acceptance.tests.filter((t) => t.type !== "adversarial").length,
    adversarial: acceptance.tests.filter((t) => t.type === "adversarial").length,
    selectors: Object.keys(acceptance.selectors || {}).length,
    coveredConfirmed: testedFeatures.size,
    confirmed: confirmed.size,
    roles: rolesSeen.size,
  };
  return { ok: errors.length === 0, errors, warnings, stats };
}

// ── 교차검증: 정책(businessRule) 커버리지 ────────────────────────────────────
// 화면 역산이 화면에 안 보이는 정책(2주 상한·2단계 승인 등)을 떨구지 않았는지 검증.
// ★ 구조적: confirmed businessRule id가 server-spec **endpoint.rules[] 배열**에 실제로 담겼는지(산문 note/logic 언급만으론 불충분 → 진짜 서버 로직에 연결됐음을 보장).
export function validateRuleCoverage(spec, serverSpec = {}) {
  const { confirmed } = ruleIndex(spec);
  const inRules = new Set();
  for (const e of serverSpec.endpoints || []) if (isArr(e.rules)) for (const r of e.rules) if (isStr(r)) inRules.add(r);
  const uncovered = [...confirmed].filter((id) => !inRules.has(id));
  return { ok: uncovered.length === 0, uncovered, confirmedRules: confirmed.size };
}

// ══════════════════════════════════════════════════════════════════════════════
// --chunked 전용 가드 (S2 validateSpecPlan/validateEnrichedGroup 스타일)
//   각 산출 = plan(아웃라인) 가드 + enriched(그룹 상세화) 가드 2개.
//     · plan  : 아웃라인 구조 + id 유일 + 필수 아웃라인 필드(상세필드 불요). 커버리지는 여기서 고정.
//     · enrich: 그룹 아웃라인 id 를 1:1 로 상세화했는지 hard(그룹 밖 창작 금지·상세필드 채워짐).
//   조립본 전체 검증은 기존 validate{PageSpec,Schema,ServerSpec,Acceptance} 를 그대로 재사용.
// ══════════════════════════════════════════════════════════════════════════════

// 그룹 상세화 결과의 공통 골격 검사: arrayKey 배열 존재 + 그룹 아웃라인 id 1:1(누락·창작 hard).
//   perItem(f, at, seen)=각 항목 상세필드 검사 콜백. → { errors, seen(Set) }
function enrichedArrayCore(obj, arrayKey, outlineIds, label, perItem) {
  const errors = [];
  if (!isObj(obj)) return { errors: [`${label}: enrich 결과가 JSON 객체 아님`], seen: new Set() };
  if (!isArr(obj[arrayKey])) return { errors: [`${label}: ${arrayKey} 배열 없음`], seen: new Set() };
  const ids = outlineIds instanceof Set ? outlineIds : new Set(outlineIds || []);
  const seen = new Set();
  obj[arrayKey].forEach((f, i) => {
    const at = `${label}.${arrayKey}[${i}]`;
    perItem(f, at, seen, ids, errors);
  });
  const missing = [...ids].filter((id) => !seen.has(id));
  if (missing.length) errors.push(`${label}: 아웃라인 ${missing.length}개 미상세화(누락): ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? " …" : ""}`);
  return { errors, seen };
}

// ── (a) page-spec ─────────────────────────────────────────────────────────────
// plan(아웃라인): ia·flows 완전 + pages 아웃라인(id/name/url/purpose/roles/features/renderScreen). 커버리지 고정.
export function validatePageSpecPlan(pageSpec, { spec = {} } = {}) {
  const errors = [], warnings = [];
  if (!isObj(pageSpec)) return { ok: false, errors: ["page-spec plan is not a JSON object"], warnings, stats: {} };
  if (!isArr(pageSpec.ia)) errors.push("ia는 배열이어야 함");
  if (!isArr(pageSpec.pages) || pageSpec.pages.length === 0) errors.push("pages(아웃라인) 비었음");
  if (!isArr(pageSpec.flows) || pageSpec.flows.length === 0) errors.push("flows 비었음(사용자 플로우 필수 — plan에서 완전히)");
  if (errors.length) return { ok: false, errors, warnings, stats: {} };

  const { all: specIds, confirmed } = featureIndex(spec);
  const pageIds = new Set();
  const covered = new Set();
  pageSpec.pages.forEach((p, i) => {
    const at = `pages[${i}](${p.name || p.id || "?"})`;
    for (const k of ["id", "name", "url", "purpose"]) if (!isStr(p[k])) errors.push(`${at}.${k} 없음/빈값 (아웃라인)`);
    if (isStr(p.id)) { if (pageIds.has(p.id)) errors.push(`${at}: 중복 페이지 id ${p.id}`); pageIds.add(p.id); }
    if (typeof p.renderScreen !== "boolean") errors.push(`${at}.renderScreen(bool) 없음`);
    if (isStr(p.url) && p.renderScreen === true && !p.url.startsWith("/")) errors.push(`${at}.url은 /로 시작해야 함(실 화면)`);
    if (!isArr(p.roles) || p.roles.length === 0) errors.push(`${at}.roles 비었음(접근 권한 필수)`);
    if (!isArr(p.features)) errors.push(`${at}.features는 배열이어야 함`);
    else for (const fid of p.features) {
      if (specIds.size && !specIds.has(fid)) errors.push(`${at}: 존재하지 않는 기능 id "${fid}" (지어냄 의심)`);
      else covered.add(fid);
    }
  });
  // ★ 커버리지(plan이 고정): confirmed 기능은 하나도 빠짐없이 어떤 페이지엔가 매핑
  const uncovered = [...confirmed].filter((id) => !covered.has(id));
  if (uncovered.length) errors.push(`confirmed 기능이 어느 페이지에도 안 실림(커버리지): ${uncovered.join(", ")}`);

  return { ok: errors.length === 0, errors, warnings, stats: { pages: pageSpec.pages.length, coveredFeatures: covered.size, confirmed: confirmed.size } };
}

// enrich(섹션 상세화): { pages:[풀 상세] }. 아웃라인 id 1:1 + 상세필드(states/renderScreen→gpt2Prompt) 채워짐.
export function validatePageSpecEnrichedGroup(obj, { outlineIds, label = "group" } = {}) {
  const { errors } = enrichedArrayCore(obj, "pages", outlineIds, label, (p, at, seen, ids, errs) => {
    if (!isStr(p.id)) { errs.push(`${at}.id 없음`); return; }
    seen.add(p.id);
    if (ids.size && !ids.has(p.id)) errs.push(`${at}: 아웃라인에 없는 id "${p.id}" (그룹 밖 창작 금지)`);
    for (const k of ["name", "url", "purpose"]) if (!isStr(p[k])) errs.push(`${at}.${k} 없음/빈값 (아웃라인 유지)`);
    if (!isArr(p.roles) || p.roles.length === 0) errs.push(`${at}.roles 비었음`);
    if (typeof p.renderScreen !== "boolean") errs.push(`${at}.renderScreen(bool) 없음`);
    if (!isArr(p.states) || p.states.length === 0) errs.push(`${at}.states 비었음 (상세화 누락 — 기본/로딩/빈상태/에러 등)`);
    if (p.renderScreen === true && !isStr(p.gpt2Prompt)) errs.push(`${at}: renderScreen이면 gpt2Prompt 필수(상세화 누락)`);
    if (!isArr(p.features)) errs.push(`${at}.features는 배열이어야 함(아웃라인 유지)`);
  });
  return { ok: errors.length === 0, errors, warnings: [], stats: { count: (obj && obj.pages || []).length } };
}

// ── (b) schema ────────────────────────────────────────────────────────────────
// plan(아웃라인): tables 아웃라인(name/purpose, columns 제외) + relations 완전.
export function validateSchemaPlan(schema) {
  const errors = [], warnings = [];
  if (!isObj(schema)) return { ok: false, errors: ["schema plan is not a JSON object"], warnings, stats: {} };
  if (!isArr(schema.tables) || schema.tables.length === 0) errors.push("tables(아웃라인) 비었음");
  if (!isArr(schema.relations)) errors.push("relations는 배열이어야 함");
  if (errors.length) return { ok: false, errors, warnings, stats: {} };

  const names = new Set();
  schema.tables.forEach((t, i) => {
    const at = `tables[${i}](${t.name || "?"})`;
    if (!isStr(t.name)) errors.push(`${at}.name 없음`);
    else { if (names.has(t.name)) errors.push(`${at}: 중복 테이블명`); names.add(t.name); }
    if (!isStr(t.purpose)) errors.push(`${at}.purpose 없음/빈값 (아웃라인 — 무엇을 담는 테이블인지)`);
  });
  (schema.relations || []).forEach((r, i) => {
    for (const k of ["from", "to"]) if (!isStr(r[k])) errors.push(`relations[${i}].${k} 없음`);
    for (const k of ["from", "to"]) {
      const tbl = String(r[k] || "").split(".")[0];
      if (names.size && isStr(r[k]) && !names.has(tbl)) errors.push(`relations[${i}].${k} "${r[k]}" 실존 테이블 아님`);
    }
  });
  return { ok: errors.length === 0, errors, warnings, stats: { tables: schema.tables.length }, tableNames: names };
}

// enrich(테이블 배치 상세화): { tables:[{name, purpose, columns:[...]}] }. name 1:1 + columns 채워짐.
export function validateSchemaEnrichedGroup(obj, { outlineIds, label = "group" } = {}) {
  const { errors } = enrichedArrayCore(obj, "tables", outlineIds, label, (t, at, seen, ids, errs) => {
    if (!isStr(t.name)) { errs.push(`${at}.name 없음`); return; }
    seen.add(t.name);
    if (ids.size && !ids.has(t.name)) errs.push(`${at}: 아웃라인에 없는 테이블 "${t.name}" (배치 밖 창작 금지)`);
    if (!isArr(t.columns) || t.columns.length === 0) errs.push(`${at}.columns 비었음 (상세화 누락)`);
    else t.columns.forEach((c, j) => {
      if (!isStr(c.name)) errs.push(`${at}.columns[${j}].name 없음`);
      if (!isStr(c.type)) errs.push(`${at}.columns[${j}].type 없음`);
    });
  });
  return { ok: errors.length === 0, errors, warnings: [], stats: { count: (obj && obj.tables || []).length } };
}

// ── (c) server-spec ───────────────────────────────────────────────────────────
// plan(아웃라인): endpoints 아웃라인(id/method/path/purpose/roles/tables/features/rules, in/out/logic 제외)
//   + dataFlow·modules 완전. tables⊂스키마·features⊂spec·rules⊂spec + 정책 커버리지 고정.
export function validateServerSpecPlan(serverSpec, { spec = {}, tableNames = new Set() } = {}) {
  const errors = [], warnings = [];
  if (!isObj(serverSpec)) return { ok: false, errors: ["server-spec plan is not a JSON object"], warnings, stats: {} };
  if (!isArr(serverSpec.endpoints) || serverSpec.endpoints.length === 0) errors.push("endpoints(아웃라인) 비었음");
  if (errors.length) return { ok: false, errors, warnings, stats: {} };

  const { all: specIds } = featureIndex(spec);
  const { all: ruleIds } = ruleIndex(spec);
  const ids = new Set();
  serverSpec.endpoints.forEach((e, i) => {
    const at = `endpoints[${i}](${e.path || e.id || "?"})`;
    if (!isStr(e.id)) errors.push(`${at}.id 없음/빈값 (하류가 id로 커버리지 키잉)`);
    else { if (ids.has(e.id)) errors.push(`${at}: 중복 endpoint id "${e.id}"`); ids.add(e.id); }
    if (!isStr(e.method)) errors.push(`${at}.method 없음`);
    if (!isStr(e.path)) errors.push(`${at}.path 없음`);
    if (!isStr(e.purpose)) errors.push(`${at}.purpose 없음/빈값 (아웃라인)`);
    if (isArr(e.tables)) for (const t of e.tables)
      if (tableNames.size && !tableNames.has(String(t).split(".")[0])) errors.push(`${at}.tables "${t}" 스키마에 없음`);
    if (isArr(e.features)) for (const f of e.features)
      if (specIds.size && !specIds.has(f)) errors.push(`${at}.features "${f}" 존재하지 않는 기능 id`);
    if (isArr(e.rules)) for (const r of e.rules)
      if (ruleIds.size && !ruleIds.has(r)) errors.push(`${at}.rules "${r}" 존재하지 않는 businessRule id`);
  });

  // dataFlow·modules 는 plan에서 완전히(다음 단계에서 안 건드림). modules 형식 = 기존 validateServerSpec 과 동일.
  if (!isArr(serverSpec.dataFlow) || serverSpec.dataFlow.length === 0) warnings.push("dataFlow 비었음(주요 흐름 서술 권장)");
  const modFiles = new Set();
  if (!isArr(serverSpec.modules) || serverSpec.modules.length === 0) {
    errors.push("modules[] 비었음 — 도메인 로직 lib 모듈 분해 필수(개발 S4가 이걸로 lib/*.ts 생성)");
  } else {
    serverSpec.modules.forEach((m, i) => {
      const at = `modules[${i}](${(m && m.file) || "?"})`;
      const f = String((m && m.file) || "").replace(/^\.?[\\/]/, "");
      if (!/^lib\/[\w.\-/]+\.ts$/.test(f)) errors.push(`${at}.file은 "lib/<이름>.ts" 형식이어야 함`);
      else { if (modFiles.has(f)) errors.push(`${at}: 중복 모듈 파일 ${f}`); modFiles.add(f); }
      if (!isStr(m && m.purpose)) errors.push(`${at}.purpose 없음`);
    });
  }

  // ★ 정책 커버리지(plan이 고정): confirmed businessRule 은 하나도 빠짐없이 어떤 endpoint.rules[] 에
  const rc = validateRuleCoverage(spec, serverSpec);
  if (!rc.ok) errors.push(`confirmed businessRule이 endpoint.rules[]에 미반영(정책 증발): ${rc.uncovered.join(", ")}`);

  return { ok: errors.length === 0, errors, warnings, stats: { endpoints: serverSpec.endpoints.length, modules: modFiles.size } };
}

// enrich(리소스 상세화): { endpoints:[풀 상세] }. id 1:1 + logic(서버 처리) 채워짐.
export function validateServerSpecEnrichedGroup(obj, { outlineIds, label = "group" } = {}) {
  const { errors } = enrichedArrayCore(obj, "endpoints", outlineIds, label, (e, at, seen, ids, errs) => {
    if (!isStr(e.id)) { errs.push(`${at}.id 없음`); return; }
    seen.add(e.id);
    if (ids.size && !ids.has(e.id)) errs.push(`${at}: 아웃라인에 없는 id "${e.id}" (리소스 밖 창작 금지)`);
    if (!isStr(e.method)) errs.push(`${at}.method 없음(아웃라인 유지)`);
    if (!isStr(e.path)) errs.push(`${at}.path 없음(아웃라인 유지)`);
    if (!isStr(e.logic)) errs.push(`${at}.logic 없음(서버 처리 설명 필수 — 상세화 누락)`);
  });
  return { ok: errors.length === 0, errors, warnings: [], stats: { count: (obj && obj.endpoints || []).length } };
}

// ── (d) acceptance ────────────────────────────────────────────────────────────
// plan(아웃라인): tests 아웃라인(id/feature_id/page/type/setup.role, steps/assert/rationale 제외).
//   바닥 커버리지(confirmed 기능→테스트≥1)를 plan에서 고정. selectors 는 enrich가 그룹별로 채움.
export function validateAcceptancePlan(acceptance, { spec = {}, pageSpec = {} } = {}) {
  const errors = [], warnings = [];
  if (!isObj(acceptance)) return { ok: false, errors: ["acceptance plan is not a JSON object"], warnings, stats: {} };
  if (!isArr(acceptance.tests) || acceptance.tests.length === 0) errors.push("tests(아웃라인) 비었음");
  if (errors.length) return { ok: false, errors, warnings, stats: {} };

  const { all: specIds, confirmed } = featureIndex(spec);
  const pageIds = new Set((pageSpec.pages || []).map((p) => p.id).filter(isStr));
  const ids = new Set();
  const testedFeatures = new Set();
  acceptance.tests.forEach((t, i) => {
    const at = `tests[${i}](${t.id || "?"})`;
    if (!isStr(t.id)) errors.push(`${at}.id 없음`);
    else { if (ids.has(t.id)) errors.push(`${at}: 중복 test id`); ids.add(t.id); }
    if (!isStr(t.feature_id)) errors.push(`${at}.feature_id 없음`);
    else if (specIds.size && !specIds.has(t.feature_id)) errors.push(`${at}.feature_id "${t.feature_id}" 존재하지 않는 기능`);
    else testedFeatures.add(t.feature_id);
    if (isStr(t.page) && pageIds.size && !pageIds.has(t.page)) errors.push(`${at}.page "${t.page}" 실존 page-spec id 아님`);
    // setup.role(기계가독) 은 아웃라인에서 이미 고정 — S5 롤 로그인 계약
    if (!isObj(t.setup)) errors.push(`${at}.setup(객체) 없음`);
    else if (!isStr(t.setup.role)) errors.push(`${at}.setup.role 없음(로그인 롤 문자열 필수)`);
  });
  // ★ 바닥 커버리지(plan이 고정): confirmed 기능마다 테스트 ≥1
  const uncovered = [...confirmed].filter((id) => !testedFeatures.has(id));
  if (uncovered.length) errors.push(`confirmed 기능에 테스트 없음(바닥 커버리지): ${uncovered.join(", ")}`);

  return { ok: errors.length === 0, errors, warnings, stats: { tests: acceptance.tests.length, coveredConfirmed: testedFeatures.size, confirmed: confirmed.size } };
}

// enrich(페이지 상세화): { selectors:{...그룹}, tests:[풀 상세] }. id 1:1 + steps/assert/setup.role 채워짐.
export function validateAcceptanceEnrichedGroup(obj, { outlineIds, label = "group" } = {}) {
  const extra = [];
  if (isObj(obj) && obj.selectors != null && !isObj(obj.selectors)) extra.push(`${label}: selectors 는 객체여야 함`);
  const { errors } = enrichedArrayCore(obj, "tests", outlineIds, label, (t, at, seen, ids, errs) => {
    if (!isStr(t.id)) { errs.push(`${at}.id 없음`); return; }
    seen.add(t.id);
    if (ids.size && !ids.has(t.id)) errs.push(`${at}: 아웃라인에 없는 id "${t.id}" (그룹 밖 창작 금지)`);
    if (!isStr(t.feature_id)) errs.push(`${at}.feature_id 없음(아웃라인 유지)`);
    if (!isObj(t.setup) || !isStr(t.setup.role)) errs.push(`${at}.setup.role 없음(아웃라인 유지)`);
    if (!isArr(t.steps) || t.steps.length === 0) errs.push(`${at}.steps 비었음 (상세화 누락)`);
    if (!isArr(t.assert) || t.assert.length === 0) errs.push(`${at}.assert 비었음 (상세화 누락)`);
    else t.assert.forEach((a, j) => { if (!isStr(a.kind)) errs.push(`${at}.assert[${j}].kind 없음`); });
  });
  return { ok: errors.length === 0 && extra.length === 0, errors: [...extra, ...errors], warnings: [], stats: { count: (obj && obj.tests || []).length } };
}
