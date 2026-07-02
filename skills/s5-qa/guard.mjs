// s5-qa · 코드 가드 (결정적 부분) — poc-forge: "가드=코드, 판단=Claude".
//   판정(브라우저 관찰)은 Claude(chrome-devtools MCP)가, 준비·검증·라우팅은 여기(코드)가.
//   - validateInputs   : S3 계약·S4 app 존재 확인(입력 계약)
//   - buildTestPlan    : acceptance/server-spec/spec → 실행 대본(.s5-plan.json). Claude가 MCP로 그대로 실행(extract-not-originate).
//                        상대날짜(+15d)를 오늘 기준 절대날짜로 결정적 해석해 대본에 박는다(드라이버는 그대로 입력).
//   - validateQaResult : Claude가 수집한 qa-result.raw.json 스키마·근거 무결 검증
//   - validateCoverage : 대본 대비 실행 커버리지(silent-drop 금지) — UI 바닥은 하드, API는 경고
//   - routeLoopback    : fail/gap 원인 → 재실행 단계(S2/S3/S4) 라우팅 (가장 상류 우선)
//   - isBlockingGap    : 폭 gap 중 pass/fail에 영향을 주는(차단성) 것 판정

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const isStr = (v) => typeof v === "string" && v.trim().length > 0;
const isArr = Array.isArray;
const isObj = (v) => v && typeof v === "object" && !isArr(v);
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// ── 입력 계약 ────────────────────────────────────────────────────────────────
export function validateInputs(projectDir) {
  const need = ["acceptance.json", "spec.json", "page-spec.json"];
  const missing = need.filter((f) => !existsSync(join(projectDir, f)));
  const appMissing = !existsSync(join(projectDir, "app", "package.json"));
  const errors = [];
  if (missing.length) errors.push(`계약 누락: ${missing.join(", ")} — S3 필요`);
  if (appMissing) errors.push("app/ 없음 — S4(빌드 그린) 필요");
  return { ok: errors.length === 0, errors };
}

// ── 상대 날짜 해석 (+15d/-3d → YYYY-MM-DD, 오늘 기준 로컬 자정 앵커) ─────────────
function fmtDate(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
export function resolveDateToken(v, today) {
  const m = /^([+-])(\d+)d$/.exec(String(v ?? "").trim());
  if (!m) return v; // 날짜 토큰이 아니면(텍스트 입력 등) 그대로
  const days = (m[1] === "-" ? -1 : 1) * parseInt(m[2], 10);
  return fmtDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + days));
}

// ── acceptance/server-spec/spec → 실행 대본(.s5-plan.json) ─────────────────────
/**
 * 결정적: 각 UI 테스트를 role·route·steps(상대날짜 해석)·asserts로 펼치고, server-spec 엔드포인트를
 * 상태·접근제어·규칙강제 checks로, spec의 confirmed 기능/BR을 폭 대조 목록으로 편다.
 * Claude는 이 대본을 그대로 MCP로 실행한다(시나리오 신규 생성 금지 — 발견은 discovered로 *추가*).
 */
export function buildTestPlan(acceptance, { serverSpec = {}, spec = {}, today = new Date() } = {}) {
  const selectors = acceptance.selectors || {};
  const endpoints = serverSpec.endpoints || [];

  // 로그인 엔드포인트는 계약에서 도출(도메인 불가지). sso/callback 우선, 없으면 login류 POST.
  const authEp = endpoints.find((e) => /sso.*callback|auth.*callback/i.test(`${e.id} ${e.path}`))
    || endpoints.find((e) => /sso|login/i.test(`${e.id} ${e.path}`) && String(e.method).toUpperCase() === "POST");
  const login = {
    method: "POST",
    path: authEp?.path || "/api/auth/login",
    body: '{"googleIdToken":"<role>"}', // role = test.setup.role 값 치환("직원|팀장|총무"). 미인증이면 로그인 스킵.
    roleValues: [...new Set((acceptance.tests || []).map((t) => t.setup?.role).filter((r) => r && r !== "미인증"))],
    note: "브라우저 evaluate_script의 fetch로 호출(한글 UTF-8 안전). 반환 Set-Cookie는 브라우저 쿠키자에 자동 적용. ★실제 로그인 경로는 Discover에서 app 코드로 확인해 다르면 실경로 사용(계약은 근거).",
  };

  // ── ① UI 테스트: acceptance.json (브라우저 MCP). 상대날짜는 절대값으로 해석.
  const uiTests = (acceptance.tests || []).map((t) => ({
    id: t.id,
    feature_id: t.feature_id,
    page: t.page || "",
    type: t.type || "normal",
    role: t.setup?.role || "미인증",
    route: t.setup?.route || "",
    setupNote: t.setup?.note || "",
    steps: (t.steps || []).map((s) => {
      const v = String(s.value ?? "").trim();
      if ((s.action === "fill" || s.action === "select") && /^[+-]\d+d$/.test(v)) {
        return { ...s, value: resolveDateToken(v, today), rawValue: v }; // 상대→절대, 원본 보존
      }
      return s;
    }),
    asserts: t.assert || [],
    rationale: t.rationale || "",
  }));

  // ── ② API 테스트: server-spec 엔드포인트 직접 검증(상태·응답·접근제어·규칙강제). fetch로 실행.
  const apiTests = endpoints
    .filter((e) => String(e.method).toUpperCase() !== "MIDDLEWARE")
    .map((e) => {
      const method = String(e.method).toUpperCase();
      const roles = e.roles || [];
      const rules = e.rules || [];
      return {
        id: `API-${e.id || `${method}-${e.path}`}`,
        endpointId: e.id, method, path: e.path, purpose: e.purpose,
        roles, in: e.in, out: e.out, logic: e.logic || "", rules,
        checks: [
          { kind: "normal", expect: "2xx", note: `허용 롤(${roles.join("|") || "any"})·정상 입력 → 성공 + 응답이 out(${e.out || "?"}) 형태` },
          ...(roles.length ? [{ kind: "access", expect: "401|403", note: "미허용 롤/미인증으로 호출 → 거부" }] : []),
          ...(rules.length ? [{ kind: "rule", expect: "4xx", note: `규칙 위반(${rules.join(",")}) 입력 → 거부. logic에서 위반 상황 구성.` }] : []),
          ...(WRITE_METHODS.has(method) ? [{ kind: "input", expect: "4xx", note: "빈/무효/경계 입력 → 거부(qa-pilot Input Attacks)" }] : []),
        ],
      };
    });

  // ── ③ 적대(qa-pilot Jinx): 입력/변경 화면에 적용할 공격 카테고리(참조: qa-pilot/references/adversarial-playbook.md)
  const adversarial = {
    categories: [
      "Input(1000자·유니코드/이모지·특수페이로드<script>·'; DROP·{{7*7}}·빈값·극단/과거·미래 날짜)",
      "Interaction(연타 중복제출 5회·전환중 클릭·더블클릭)",
      "Navigation(미인증 딥링크·URL param 변조·마법사 중간 새로고침·뒤로가기)",
      "State(빈 제출·필수 사전단계 건너뜀·모달 2회 오픈·필수값 지우기)",
    ],
    targets: uiTests
      .filter((t) => (t.steps || []).some((s) => /fill|click|select/.test(s.action)))
      .map((t) => t.route)
      .filter((v, i, a) => v && a.indexOf(v) === i),
    note: "acceptance 적대(§S3)를 넘어서는 탐색. 발견은 gaps 또는 fail(cause 판정)로. ★실익스플로잇 금지 — 의심 보안은 사람 후속으로 기록만(notes).",
  };

  // ── ④ 폭: confirmed 기능·BR spot-check (테스트가 직접 안 건드린 것 대조)
  const breadth = {
    features: (spec.features || []).filter((f) => f.status === "confirmed").map((f) => ({ id: f.id, 기능: f.기능, 상세내용: f.상세내용 })),
    rules: (spec.businessRules || []).filter((r) => r.status !== "open").map((r) => ({ id: r.id, rule: r.rule })),
    note: "①②③이 직접 커버하지 않은 confirmed 기능·BR을 앱 실동작과 대조. 누락/불일치는 gaps로(cause 판정).",
  };

  return {
    login, selectors, uiTests, apiTests, adversarial, breadth,
    accessDenySelector: selectors["권한없음 안내"] || "[data-testid=forbidden]", // 페이지 접근거부(200+컴포넌트) 판정용
    counts: {
      ui: uiTests.length, api: apiTests.length, selectors: Object.keys(selectors).length,
      breadthFeatures: breadth.features.length, breadthRules: breadth.rules.length,
      adversarialTargets: adversarial.targets.length,
    },
  };
}

// ── qa-result 스키마·근거 검증 ────────────────────────────────────────────────
const RESULT_KEYS = ["test_id", "pass"];
export function validateQaResult(qa) {
  const errors = [], warnings = [];
  if (!isObj(qa)) return { ok: false, errors: ["qa-result가 객체 아님"], warnings };
  if (!isArr(qa.results)) errors.push("results 배열 없음");
  else if (qa.results.length === 0) errors.push("results 비어있음 — MCP 실행이 아무 테스트도 기록 안 함(구동 단계 누락?)");
  else qa.results.forEach((r, i) => {
    for (const k of RESULT_KEYS) if (r[k] === undefined) errors.push(`results[${i}].${k} 없음`);
    if (r.test_id !== undefined && !isStr(r.test_id)) errors.push(`results[${i}].test_id는 비어있지 않은 문자열`);
    if (typeof r.pass !== "boolean") errors.push(`results[${i}].pass는 bool`);
    // ★ 근거 무결: fail은 반드시 실행 근거가 있어야(근거 없는 판정 금지)
    if (r.pass === false && !isStr(r.evidence)) errors.push(`results[${i}](${r.test_id}) fail인데 evidence 없음 — 근거 필수`);
  });
  if (qa.gaps !== undefined) {
    if (!isArr(qa.gaps)) errors.push("gaps는 배열이어야 함");
    else qa.gaps.forEach((g, i) => {
      if (!isStr(g.ref) && !isStr(g.missing)) warnings.push(`gaps[${i}] ref/missing 누락 — 폭 gap 서술 불완전`);
      if (!isStr(g.evidence)) warnings.push(`gaps[${i}](${g.ref || "?"}) evidence 없음 — 근거 권장`);
    });
  } else warnings.push("gaps 배열 없음(폭 판정 누락 가능 — teaching-to-test 방지 위해 폭 점검 필요)");
  if (qa.notes !== undefined && !isArr(qa.notes)) warnings.push("notes는 배열이어야 함(비차단 관찰용)");
  return { ok: errors.length === 0, errors, warnings };
}

// ── 커버리지: 대본 대비 실행 여부(silent-drop 금지) ─────────────────────────────
/** 대본의 UI/API 테스트가 결과에 다 있는지. UI 바닥 미실행은 하드(finalize에서 error), API 미실행은 경고. */
export function validateCoverage(plan, qa) {
  const ran = new Set((qa.results || []).map((r) => r.test_id));
  const uiIds = (plan.uiTests || []).map((t) => t.id);
  const apiIds = (plan.apiTests || []).map((t) => t.id);
  const missingUi = uiIds.filter((id) => !ran.has(id));
  const missingApi = apiIds.filter((id) => !ran.has(id));
  return {
    missingUi, missingApi,
    ranUi: uiIds.length - missingUi.length, totalUi: uiIds.length,
    ranApi: apiIds.length - missingApi.length, totalApi: apiIds.length,
  };
}

// ── 폭 gap 차단성 판정 ─────────────────────────────────────────────────────────
/** gap이 pass/fail에 영향(차단)을 주는가. blocking:false 또는 severity=low/info면 비차단(관찰). 기본 차단. */
export function isBlockingGap(g) {
  if (g && g.blocking === false) return false;
  if (g && typeof g.severity === "string" && /^(low|info|정보|관찰|cosmetic)$/i.test(g.severity.trim())) return false;
  return true;
}

// ── 루프백 라우팅 ────────────────────────────────────────────────────────────
const STAGE_ORDER = { S2: 0, S3: 1, S4: 2 }; // 가장 상류(작은 값) 우선
/**
 * 각 fail/차단gap의 cause(S2|S3|S4)를 모아 가장 상류 단계로 라우팅. cause 없으면 휴리스틱.
 *   - 요건 미명세/모호 → S2 · 화면/엔드포인트 설계 누락 → S3 · 셀렉터/로직/상태전이 → S4
 */
export function routeLoopback(qa) {
  const causes = [];
  for (const r of qa.results || []) if (r.pass === false) causes.push(r.cause || guessCause(r));
  for (const g of qa.gaps || []) if (isBlockingGap(g)) causes.push(g.cause || guessGapCause(g));
  const valid = causes.filter((c) => c in STAGE_ORDER);
  if (!valid.length) return null;
  const breakdown = valid.reduce((m, c) => ((m[c] = (m[c] || 0) + 1), m), {});
  const stage = valid.sort((a, b) => STAGE_ORDER[a] - STAGE_ORDER[b])[0]; // 가장 상류
  const parts = Object.entries(breakdown).sort((a, b) => STAGE_ORDER[a[0]] - STAGE_ORDER[b[0]]).map(([s, n]) => `${s}:${n}`);
  return { stage, reason: `${valid.length}건 실패/누락(${parts.join(", ")}) 중 최상류 원인=${stage}`, breakdown };
}
function guessCause(r) {
  const s = `${r.failReason || ""} ${r.evidence || ""}`;
  if (/미명세|요건|모호|스펙에 없|not specified|기획/i.test(s)) return "S2";
  if (/화면|필드|플로우|엔드포인트|설계|라우트 없|route 없|not designed|미설계/i.test(s)) return "S3";
  return "S4"; // 기본: 코드(셀렉터/로직/상태)
}
function guessGapCause(g) {
  if (g.cause) return g.cause;
  const s = `${g.kind || ""} ${g.missing || ""} ${g.evidence || ""}`;
  if (/미명세|요건|모호|기획에 없/i.test(s)) return "S2";
  if (/로직|상태전이|서버 미강제|셀렉터|미부여|코드/i.test(s)) return "S4";
  return "S3"; // 폭 gap 기본: 설계 누락
}
