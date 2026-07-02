// s4-build · 코드 가드 + 결정적 파일 플랜 매핑
//   - buildFilePlan : 계약(server-spec·page-spec)에서 생성 대상 파일을 *결정적으로* 도출(하드코딩 X, 지어냄 X)
//   - validateBuildGreen : next build exit 0 = 하드게이트(빌드 그린 없이 S5 금지)
//   - validateSelectorCoverage : acceptance.selectors의 data-testid가 생성 코드에 실제 존재(셀렉터 계약)
//   - validateRouteCoverage : 모든(비 MIDDLEWARE) 엔드포인트에 대응 route.ts 존재
//   - validateStrayRoutes   : route/page 특수파일이 app/ 라우터 밖에 오배치되면 지목(조용한 404 방지)
//   - validateRequiredFiles : 필수 파일 존재
// 모두 "커버리지 = silent-drop 방지"를 코드로 강제.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const isStr = (v) => typeof v === "string" && v.trim().length > 0;

// ── 결정적 매핑 헬퍼 ──────────────────────────────────────────────────────────

/** server-spec 엔드포인트 → Next App Router route 파일 경로. MIDDLEWARE/비 API는 null(스킵). */
export function endpointToRouteFile(ep) {
  const method = String(ep.method || "").toUpperCase();
  if (method === "MIDDLEWARE") return null; // 서버측 가드 = lib/auth.ts (라우트 아님)
  if (method === "JOB") {
    // 배치: id로 결정(EP-batch-due-soon → app/api/jobs/due-soon/route.ts)
    const slug = String(ep.id || "").replace(/^EP-batch-/, "").trim() || "job";
    return `app/api/jobs/${slug}/route.ts`;
  }
  const path = String(ep.path || "");
  if (!path.startsWith("/api/")) return null;
  // 동적 세그먼트 정규화: "{id}"(중괄호) 또는 ":id"(콜론, Express식) → Next "[id]".
  //   S3 server-spec의 LLM 표기 변산(둘 다 나옴)을 흡수 — 콜론은 Windows 폴더명 불가라 반드시 변환.
  //   "/api/loans/{id}/cancel" · "/api/todos/:id/toggle" → "app/api/.../[id]/.../route.ts"
  const seg = path.replace(/^\//, "").replace(/\{([^}]+)\}/g, "[$1]").replace(/:([A-Za-z0-9_]+)/g, "[$1]");
  return `app/${seg}/route.ts`;
}

/** page-spec의 renderScreen 페이지 → Next App Router page 파일 경로. url은 이미 [assetNo] 형식. */
export function pageToFile(page) {
  const url = String(page.url || "");
  if (!url.startsWith("/")) return null; // (global)/(backend) = 화면 아님
  return url === "/" ? "app/page.tsx" : `app${url}/page.tsx`;
}

/**
 * 계약에서 생성 대상(가변) 파일 플랜을 결정적으로 도출.
 * @returns {{layers: {id:string, files:{path,kind,spec}[]}[], routeFiles:string[], pageFiles:string[]}}
 */
export function buildFilePlan({ serverSpec = {}, pageSpec = {} } = {}) {
  // Ⓐ data
  const A = [
    { path: "lib/enums.ts", kind: "data-enums" },
    { path: "lib/schema.ts", kind: "data-schema" },
    { path: "lib/seed.ts", kind: "data-seed" },
  ];
  // Ⓑ domain — server-spec.modules[]에서 **결정적 도출**(도메인 불가지; 하드코딩 목록 제거).
  //   S3가 도메인 로직의 lib 분해를 선언(각 {file:"lib/xxx.ts", purpose}). API·페이지가 import할 표면.
  //   의존 순서대로 선언되어야(레이어 B는 순차 생성 = 앞 파일 export 표면을 뒤가 봄).
  //   ★ 레이어 A(enums/schema/seed) + 스캐폴드(db/brand)와 겹치는 파일은 제외(중복 생성·시임 덮어쓰기 방지) — S3가 db.ts 등을 모듈로 열거해도 안전.
  const B_EXCLUDE = new Set(["lib/enums.ts", "lib/schema.ts", "lib/seed.ts", "lib/db.ts", "lib/brand.ts"]);
  const seenB = new Set();
  const DOMAIN = (serverSpec.modules || [])
    .map((m) => (m && typeof m.file === "string" ? m.file.replace(/^\.?[\\/]/, "") : ""))
    .filter((f) => f.startsWith("lib/") && !B_EXCLUDE.has(f) && !seenB.has(f) && seenB.add(f))
    .map((f) => ({ path: f, kind: "domain", spec: String((serverSpec.modules.find((m) => String(m.file || "").replace(/^\.?[\\/]/, "") === f) || {}).purpose || f) }));

  // Ⓒ api — server-spec 엔드포인트를 route 파일로 그룹(같은 경로의 여러 method = 한 파일)
  const routeMap = new Map(); // routeFile → endpoints[]
  for (const ep of serverSpec.endpoints || []) {
    const rf = endpointToRouteFile(ep);
    if (!rf) continue;
    if (!routeMap.has(rf)) routeMap.set(rf, []);
    routeMap.get(rf).push(ep);
  }
  const C = [...routeMap.entries()].map(([path, eps]) => ({ path, kind: "api", spec: eps }));
  const routeFiles = [...routeMap.keys()];

  // Ⓓ chrome — ui(프리미티브) 먼저, layout이 ui를 import하므로 순차 생성 순서 보장
  const D = [
    { path: "components/ui.tsx", kind: "ui" },
    { path: "app/layout.tsx", kind: "layout", spec: pageSpec.ia || [] },
  ];

  // Ⓔ pages — renderScreen 화면만
  const pageFiles = [];
  const E = [];
  for (const p of pageSpec.pages || []) {
    if (p.renderScreen !== true) continue;
    const path = pageToFile(p);
    if (!path) continue;
    pageFiles.push(path);
    E.push({ path, kind: "page", spec: p });
  }

  return {
    layers: [
      { id: "A", files: A },
      { id: "B", files: DOMAIN },
      { id: "C", files: C },
      { id: "D", files: D },
      { id: "E", files: E },
    ],
    routeFiles,
    pageFiles,
  };
}

/**
 * 파일 플랜 무결(계약 대비) — endpointToRouteFile/pageToFile이 null을 돌려주면 그 엔드포인트/페이지가
 * plan·커버리지 양쪽에서 조용히 사라진다(self-referential 구멍). 계약 원본과 대조해 loud fail.
 */
export function validatePlanCoverage(serverSpec = {}, pageSpec = {}) {
  const errors = [];
  for (const ep of serverSpec.endpoints || []) {
    const method = String(ep.method || "").toUpperCase();
    if (method === "MIDDLEWARE") continue; // 라우트 아님(서버 가드=lib/auth) — 유일한 정당 제외
    if (!endpointToRouteFile(ep))
      errors.push(`엔드포인트 ${ep.id || ep.path || "?"}(${method} ${ep.path || ""}) 라우트 매핑 실패(silent-drop) — path는 /api/… 형식이어야`);
  }
  for (const p of pageSpec.pages || []) {
    if (p.renderScreen !== true) continue;
    if (!pageToFile(p))
      errors.push(`화면 페이지 ${p.id || "?"}(url ${p.url || ""}) page 매핑 실패(silent-drop) — url은 /로 시작해야`);
  }
  return { ok: errors.length === 0, errors };
}

// ── 입력 계약 검증 ────────────────────────────────────────────────────────────
export function validateInputs(projectDir) {
  const need = ["dev-doc.md", "page-spec.json", "schema.json", "server-spec.json", "acceptance.json", "spec.json", "context.json"];
  const missing = need.filter((f) => !existsSync(join(projectDir, f)));
  return { ok: missing.length === 0, missing };
}

// ── 산출 가드 ─────────────────────────────────────────────────────────────────

/** next build 결과(exit 0) = 하드게이트. */
export function validateBuildGreen(build) {
  if (!build) return { ok: false, errors: ["빌드가 실행되지 않음"] };
  if (build.ok) return { ok: true, errors: [] };
  return { ok: false, errors: [`next build 실패(exit ${build.code}). 빌드 그린 없이 S5 진입 금지.`] };
}

// 생성 코드에서 data-testid="..." 를 수집(정적 스캔)
const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx"]);
function collectTestIds(appDir) {
  const ids = new Set();
  const prefixes = new Set(); // 동적(템플릿 리터럴) testid의 정적 프리픽스 — 예: `category-tab-${c}` → "category-tab-"
  // 셀렉터는 여러 방식으로 부여된다:
  //   ① 리터럴 data-testid="X"  ② 공용 컴포넌트의 testId 계열 prop/기본값(testId / confirmTestId / errorTestId / cancelTestId …)
  //      (예: <InlineError testId="error-limit"/> · <ConfirmDialog confirmTestId="reject-confirm-btn"/> · <TextArea errorTestId="error-reject-reason"/>)
  //   ③ 동적 생성: data-testid={`category-tab-${c}`} / testId: `category-tab-${c}` → 정적 프리픽스로 계열 인정.
  // 주석(//, /* */, {/* */}, * JSDoc) 안의 언급은 세지 않는다(실제 부여만 카운트).
  const re = /data-testid\s*=\s*\{?\s*["'`]([^"'`]+)["'`]/g;               // 리터럴 data-testid="X" / {"X"}
  const reProp = /\b\w*[Tt]estId\s*[=:]\s*["'`]([^"'`]+)["'`]/g;           // testId/confirmTestId/errorTestId/… = "X" | : "X"
  const reTpl = /(?:data-testid\s*=\s*\{?\s*`|\b\w*[Tt]estId\s*[=:]\s*\{?\s*`)([^`]*?)\$\{/g; // 동적 프리픽스(백틱 앞부분)
  const stripComments = (s) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const walk = (dir) => {
    let ents = [];
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === "node_modules" || e.name === ".next" || e.name.startsWith(".")) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (CODE_EXT.has(extname(e.name))) {
        const src = stripComments(readFileSync(abs, "utf8"));
        let m;
        while ((m = re.exec(src))) ids.add(m[1]);
        while ((m = reProp.exec(src))) ids.add(m[1]);
        while ((m = reTpl.exec(src))) { const p = m[1]; if (p && p.length >= 2) prefixes.add(p); }
      }
    }
  };
  walk(appDir);
  return { ids, prefixes };
}

/**
 * 셀렉터 계약: acceptance.selectors의 [data-testid=X] 를 생성 코드가 실제로 부여했는지.
 * S5가 이 셀렉터로 검수하므로 미부여 = 계약 위반(hard). 리터럴·testId계열 prop·동적 프리픽스 모두 인정
 * (정적 스캔의 false-negative 방지 — 실제 런타임 DOM엔 있는데 못 잡던 category-tab-${c}·errorTestId 등).
 */
export function validateSelectorCoverage(appDir, acceptance) {
  const errors = [], warnings = [];
  const sel = acceptance?.selectors || {};
  const wanted = new Set();
  for (const v of Object.values(sel)) {
    const m = String(v).match(/data-testid=([^\]\s]+)/);
    if (m) wanted.add(m[1]);
  }
  const { ids: present, prefixes } = collectTestIds(appDir);
  const pref = [...prefixes];
  const covered = (id) => present.has(id) || pref.some((p) => id.startsWith(p) && id.length > p.length);
  const missing = [...wanted].filter((id) => !covered(id));
  const stats = { wanted: wanted.size, present: present.size, covered: wanted.size - missing.length };
  if (missing.length) errors.push(`셀렉터 계약 미부여(${missing.length}/${wanted.size}) — 생성 코드에 data-testid 없음: ${missing.join(", ")}`);
  return { ok: errors.length === 0, errors, warnings, stats, missing };
}

/** 라우트 커버리지: 모든 route 파일이 실제로 생성됐는지. */
export function validateRouteCoverage(appDir, routeFiles) {
  const missing = (routeFiles || []).filter((rf) => !existsSync(join(appDir, rf)));
  return { ok: missing.length === 0, errors: missing.length ? [`route 파일 누락(${missing.length}): ${missing.join(", ")}`] : [], missing };
}

/** 필수 파일 존재. */
export function validateRequiredFiles(appDir) {
  const req = ["package.json", "app/layout.tsx", "app/page.tsx", "lib/schema.ts", "lib/db.ts"];
  const missing = req.filter((r) => !existsSync(join(appDir, r)) || readFileSync(join(appDir, r), "utf8").trim() === "");
  return { ok: missing.length === 0, errors: missing.length ? [`필수 파일 누락/빈값: ${missing.join(", ")}`] : [], missing };
}

/**
 * 오배치 감지: Next 특수 파일(route.*·page.*)이 **app/ 라우터 트리 밖**에 있으면 Next가 서빙하지 않는다.
 *   전형적 함정 = 프로젝트 루트가 그 자체로 `app/`(runs/<p>/app)이라, App Router 경로 `app/api/...`를
 *   빠뜨리고 `api/...`(= runs/<p>/app/api)에 파일을 만드는 실수 → 엔드포인트가 조용히 404.
 *   route/page 커버리지 가드는 "누락"으로만 잡아 원인이 불명확 → 여기서 **오배치를 정확히 지목**한다.
 *   (run.mjs의 writeApp은 결정적 경로라 오배치 없음; 수동/서브에이전트/외부 편집의 안전망.)
 */
export function validateStrayRoutes(appDir) {
  const stray = [];
  const walk = (dir, rel) => {
    let ents = [];
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (["node_modules", ".next", ".git", "data"].includes(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), r);
      else if (/^(route|page)\.(tsx?|jsx?)$/.test(e.name) && !r.startsWith("app/")) stray.push(r);
    }
  };
  walk(appDir, "");
  const errors = stray.map((p) => `오배치: ${p} — App Router 밖이라 Next가 서빙 안 함. → app/${p} 로 이동 필요.`);
  return { ok: stray.length === 0, errors, stray };
}

/**
 * next build stderr/stdout에서 우리 가변 파일 경로를 추출(자동복구 루프가 지목 파일만 재생성).
 * @param {string} log  빌드 로그
 * @param {string[]} variablePaths  플랜의 가변 파일 상대경로들
 */
export function parseBuildErrorFiles(log, variablePaths) {
  const hit = new Set();
  const norm = (p) => p.replace(/^\.?[\\/]/, "").replace(/\\/g, "/");
  const set = new Set(variablePaths.map(norm));
  // ./app/foo/page.tsx, app/foo/page.tsx, lib/bar.ts (:line:col) 등
  const re = /(?:^|[\s(])\.?[\\/]?((?:app|lib|components)[\w./\[\]-]*\.(?:tsx?|jsx?))/g;
  let m;
  while ((m = re.exec(log))) { const p = norm(m[1]); if (set.has(p)) hit.add(p); }
  return [...hit];
}
