// s4-build · 내부 단계 오케스트레이션 (레이어드 + 파일단위 병렬 + 빌드그린 자동복구)
//   IN : runs/<p>/{dev-doc.md,page-spec.json,schema.json,server-spec.json,acceptance.json,spec.json,context.json} + sources/
//   OUT: runs/<p>/app/  (Next.js App Router) + 빌드 그린(next build exit 0)
//   흐름: 0 로드 → 1 결정적 스캐폴딩 → 2 레이어드 코드젠(A data→B domain→C api→D chrome→E pages, export 표면 전파)
//         → 3 npm install + next build + 자동복구 루프 → 4 가드(빌드그린·셀렉터·라우트·필수파일)
//   사용: node run.mjs <project> [--no-build|--build-only] [--layers=A,B,C,D,E] [--max-repair=N]
//   LLM 스왑: POC_FORGE_LLM_CMD

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, resolve, basename, dirname, extname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildFilePlan, validateInputs, validateBuildGreen, validateSelectorCoverage,
  validateRouteCoverage, validateStrayRoutes, validateRequiredFiles, parseBuildErrorFiles, validatePlanCoverage,
} from "./guard.mjs";
import { fingerprint, stampMeta, commitRun, stalenessWarnings } from "../../lib/version.mjs";
import { cleanFileOutput, cleanMarkdownDoc } from "./clean.mjs";

const SKILL_DIR = fileURLToPath(new URL(".", import.meta.url));

function resolveProjectDir(arg) {
  if (!arg) throw new Error("프로젝트를 지정하세요: node run.mjs <project>");
  if (arg.includes("/") || arg.includes("\\")) return resolve(arg);
  return resolve(SKILL_DIR, "..", "..", "runs", arg);
}
const readIf = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");

// dev-doc.md의 산문 프리앰블/꼬리말 제거 → 프롬프트엔 본문만 (공용 lib/clean.mjs)
const cleanDevDoc = cleanMarkdownDoc;

// 시드용 실데이터 자산 = S1이 useFor에 S4-sample-data(또는 seed)로 태깅한 소스 파일. 하드코딩 파일명 없음(도메인 불가지).
function seedDataAssets(projectDir, context) {
  const out = [];
  for (const a of context.assets || []) {
    if (!a.readable) continue;
    if (!(a.useFor || []).some((u) => /S4-sample-data|sample-data|seed/i.test(String(u)))) continue;
    const p = join(projectDir, "sources", a.file);
    if (existsSync(p)) out.push({ file: a.file, content: readFileSync(p, "utf8") });
  }
  return out;
}

// 브랜드·태그라인·SSO 이메일도메인 = 계약(spec.product·context)에서 도출. gearloan/삼주테크 하드코딩 없음.
function deriveBrand(up) {
  const p = up.spec?.product || {};
  const name = (p.name || "App").replace(/\s*\(.*?\)\s*/g, "").trim() || "App";
  const goal = String(p.goal || p.northStar || "").split(/[.\n·]/)[0].trim();
  const tagline = goal && goal.length <= 60 ? goal : name;
  // SSO 화이트리스트 도메인: 계약에 @도메인이 실재하면 그걸, 없으면 브랜드 슬러그 기반 중립 placeholder(지어내기보다 정직).
  const blob = JSON.stringify(up.spec || {}) + JSON.stringify(up.context || {});
  const found = blob.match(/@[a-z0-9][a-z0-9.\-]*\.[a-z]{2,}/i);
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "") || "app";
  const emailDomain = found ? found[0] : `@${slug}.example`;
  return { name, tagline, emailDomain };
}

function loadUpstream(projectDir) {
  const iv = validateInputs(projectDir);
  if (!iv.ok) throw new Error(`S3 산출 누락: ${iv.missing.join(", ")} — 먼저 S3(design) 실행`);
  const jf = (n) => JSON.parse(readFileSync(join(projectDir, n), "utf8"));
  const context = jf("context.json");
  return {
    devDoc: cleanDevDoc(readFileSync(join(projectDir, "dev-doc.md"), "utf8")),
    pageSpec: jf("page-spec.json"),
    schema: jf("schema.json"),
    serverSpec: jf("server-spec.json"),
    acceptance: jf("acceptance.json"),
    spec: jf("spec.json"),
    context,
    dataAssets: seedDataAssets(projectDir, context),
  };
}

// ── LLM ────────────────────────────────────────────────────────────────────
function callLLM(prompt) {
  return new Promise((res, rej) => {
    const cmd = process.env.POC_FORGE_LLM_CMD || "claude -p";
    const child = spawn(cmd, { shell: true });
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); // 청크경계 UTF-8(한국어) 손상 방지
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", rej);
    child.on("close", (code) => (code === 0 ? res(out) : rej(new Error(`LLM 종료코드 ${code}: ${err.slice(0, 500)}`))));
    child.stdin.on("error", () => {}); // 자식이 조기 종료해도 EOF write로 크래시하지 않게
    try { child.stdin.write(prompt); child.stdin.end(); } catch {}
  });
}
// LLM 출력 정리(코드펜스 + 산문 프리앰블/꼬리말 제거)는 공용 clean.mjs 재사용.
// export 표면 추출(선언 헤드 라인) — "여기 있는 이름만 import"의 근거
function extractExportSurface(code) {
  const lines = [];
  for (const raw of code.split(/\r?\n/)) {
    const l = raw.trim();
    if (/^export\b/.test(l) && /\b(function|const|let|var|class|interface|type|enum|default|\{)/.test(l)) {
      lines.push(l.replace(/\s*\{?\s*$/, "").replace(/=>.*$/, "=> …").slice(0, 200));
    }
  }
  return lines.join("\n");
}
function surfaceOf(appDir, rel) {
  const abs = join(appDir, rel);
  if (!existsSync(abs)) return "";
  const s = extractExportSurface(readFileSync(abs, "utf8"));
  return s ? `// @/${rel.replace(/\.tsx?$/, "").replace(/^/, "")}\n${s}` : "";
}

// ── 동시성 풀 ─────────────────────────────────────────────────────────────────
async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let idx = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (idx < items.length) {
        const i = idx++;
        try { results[i] = await worker(items[i], i); }
        catch (e) { results[i] = { error: String(e.message || e) }; }
      }
    })
  );
  return results;
}

// ── KIND별 가이드 ─────────────────────────────────────────────────────────────
// ★ 도메인 불가지: 아래 가이드는 *구조적 규율*만 담고, 구체 값(enum·테이블·시드·라벨)은 계약(dev-doc·schema·page-spec·셀렉터)에서 그대로 도출한다. 특정 도메인 리터럴 금지.
const KIND_GUIDES = {
  "data-enums":
    "역할: 앱 전체 enum의 **유일 정의**(dev-doc의 열거형 섹션 + schema.json). dev-doc/schema에 정의된 **모든** 열거형(상태·분류·롤·이벤트·알림 등)을 그 정의된 값 **그대로**(원어 문자열, 지어내기 금지) 리터럴 유니온 `type` + `as const` 배열로 export. 표시 라벨/색 키가 필요하면 함께. lib/schema·lib의 도메인 모듈이 이 타입을 import한다.",
  "data-schema":
    "역할: schema.json의 **모든 테이블**을 SQLite DDL로. **반드시** `export const SCHEMA_SQL: string[]`(각 원소 = `CREATE TABLE IF NOT EXISTS ...`, 컬럼명·nullable·PK·FK를 schema.json 그대로; BOOLEAN→INTEGER, DATE/TIMESTAMP→TEXT ISO). 각 테이블 행 타입을 `export interface`로도 정의(컬럼=필드). enum 문자열 타입은 `@/lib/enums`에서 import해 타입에 사용. lib/db.ts가 이 `SCHEMA_SQL`을 실행하므로 이름·형태를 정확히.",
  "data-seed":
    "역할: **`export async function seedIfEmpty(db: import('@libsql/client').Client): Promise<void>`** — 주요 엔티티 테이블이 비어있을 때만 dev-doc의 시드 정의를 `db.execute({sql, args})` 파라미터 바인딩으로 INSERT(멱등). **아래 CONTRACTS의 시드 원본(실데이터 자산)이 있으면 그 레코드를 그대로** 사용, 나머지(사용자·이력·알림·집계 파생 등)는 dev-doc의 파생 규칙대로 복원. **시간민감(임박/지연/마감 등) 레코드의 날짜는 `SEED_NOW`(오늘, `new Date()`) 기준 상대 앵커링**해 데모 상태(임박/지연 등)가 실행일과 무관히 결정적이게 한다.",
  domain:
    "역할: 도메인 로직 모듈(dev-doc의 서버 로직/BR/쿼리). `@/lib/db`의 `db`·`ensureReady`, `@/lib/schema` 행 타입, `@/lib/enums` 사용. **조회/변경 함수 시작에 `await ensureReady()`**. export 함수는 반환 타입 명시(다음 레이어가 이 표면을 본다). 정책(BR)은 여기서 진짜 강제 — teaching-to-test 아님. 다른 lib 모듈이 필요하면 아래 export 표면의 이름만 import.",
  api:
    "역할: Next App Router route handler. 아래 엔드포인트(server-spec)를 1:1 구현 — 각 method를 `export async function GET/POST/PATCH(req: Request, ctx: { params: ... })`로. `@/lib/*` 도메인 함수 호출 + `@/lib/auth` 가드(롤/소유 위반 403), 규칙 위반 4xx `Response.json({error,code},{status})`, 성공 2xx JSON. dev-doc 로직 순서 준수. 파일 맨 위 `export const dynamic = 'force-dynamic';` `export const runtime = 'nodejs';`.",
  ui:
    "역할: `components/ui.tsx` — 전 화면 공용 프리미티브를 한 파일에 정의·export(상호작용 필요 컴포넌트는 파일 상단 `'use client'`). page-spec components·셀렉터 계약에서 필요한 프리미티브를 도출: enum/상태 뱃지(색+텍스트 병행=색맹 대비), Tabs, EmptyState(`data-testid=empty-state`), Pagination, Modal, ConfirmDialog, InlineError, AccessDenied(`data-testid=access-denied`, 접근거부 안내) 등. `@/lib/enums` 라벨 사용 가능.",
  layout:
    "역할: `app/layout.tsx` — 전역 chrome **단독 소유**(dev-doc). 서버 컴포넌트로 `@/lib/session`에서 현재 세션을 읽어 **롤별 메뉴 분기**. `<html lang=…>` `<body>` 안 최상위 요소에 셀렉터 계약의 전역 chrome `data-testid`(예: `app-root`·`global-header`) + `data-theme=ci-blue`, 전역 헤더(좌 브랜드=`@/lib/brand`, 중앙 아래 IA 메뉴, 우 사용자 이름·소속+로그아웃), **관리자 권한 전용 메뉴 항목엔 셀렉터 계약의 해당 data-testid**, 모바일 토글 `data-testid=mobile-nav-toggle`(항상 렌더). `./globals.css` import. 로그인 등 미인증도 깨지지 않게(세션 없으면 헤더 메뉴 최소). 페이지는 본문만 렌더한다.",
  page:
    "역할: Next App Router 페이지. 아래 page-spec 화면(components·fields·states·actions)을 **실데이터로** 구현. 조회는 서버 컴포넌트에서 `@/lib/*` 직접 호출(필요 시 파일 상단 `export const dynamic='force-dynamic'`), 필터/탭/토글 등 상호작용은 별도 `'use client'` 컴포넌트로 분리하고 URL query(`?category=`,`?tab=` 등)→서버 필터로 실제 동작. mutation은 아래 엔드포인트로 fetch(POST/PATCH) 후 `router.refresh()`/이동. **셀렉터 계약의 data-testid를 실동작 요소에 실제 부여**(빈 껍데기 금지). 빈 섹션도 EmptyState. 접근 권한 없으면 `@/components/ui`의 AccessDenied 렌더하고 본문 미렌더. 콘텐츠 이미지는 회색 placeholder.",
};

// ── 결정적 스캐폴딩 (LLM 0) ────────────────────────────────────────────────────
function scaffold(project, brand) {
  const S = {};
  S["package.json"] = JSON.stringify({
    name: `${project}-app`, private: true, version: "0.1.0",
    scripts: { dev: "next dev", build: "next build", start: "next start" },
    dependencies: { next: "14.2.5", react: "18.3.1", "react-dom": "18.3.1", "@libsql/client": "0.14.0" },
    devDependencies: {
      typescript: "5.5.4", "@types/node": "20.14.10", "@types/react": "18.3.3", "@types/react-dom": "18.3.0",
      tailwindcss: "3.4.7", postcss: "8.4.39", autoprefixer: "10.4.19",
    },
  }, null, 2) + "\n";

  S["next.config.mjs"] =
`/** @type {import('next').NextConfig} */
// 빌드 게이트 = "컴파일·번들·모듈해석": 없는 *모듈* import(Cannot find module)·문법 오류는 실패로 잡힘.
//   단 존재 모듈의 *없는 named export* 는 next가 warning으로만 취급(빌드 실패 아님) → 이건 빌드가 아니라
//   레이어드 코드젠의 **export 표면 전파**가 1차 방어(드리프트 예방). 타입 미스매치도 무시(behavior 게이트는 S5).
const nextConfig = {
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
  experimental: { serverComponentsExternalPackages: ["@libsql/client", "libsql"] },
};
export default nextConfig;
`;

  S["tsconfig.json"] = JSON.stringify({
    compilerOptions: {
      target: "ES2020", lib: ["dom", "dom.iterable", "esnext"], allowJs: true, skipLibCheck: true,
      strict: true, noEmit: true, esModuleInterop: true, module: "esnext", moduleResolution: "bundler",
      resolveJsonModule: true, isolatedModules: true, jsx: "preserve", incremental: true,
      plugins: [{ name: "next" }], paths: { "@/*": ["./*"] },
    },
    include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
    exclude: ["node_modules"],
  }, null, 2) + "\n";

  S["postcss.config.mjs"] = `export default { plugins: { tailwindcss: {}, autoprefixer: {} } };\n`;
  // ★ 디자인 시스템 토큰 베이킹(knowledge/design-system/tokens.md distill) — 생성 컴포넌트가 자동 상속.
  //   도메인 불가지: 미감(색 스케일·라운드·그림자·타이포)은 고정, accent(브랜드색)는 data-theme 슬롯으로 오버라이드.
  S["tailwind.config.ts"] =
`import type { Config } from "tailwindcss";
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: { sans: ["Pretendard", "Pretendard Variable", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"] },
      colors: {
        surface: { DEFAULT: "#ffffff", muted: "#f7f9fc" },
        ink: "#111827", secondary: "#526174", muted: "#64748b",
        line: { DEFAULT: "#d9e2ec", soft: "#e7edf4" },
        accent: { DEFAULT: "#2779eb", strong: "#1f6feb", tint: "#eaf2ff", ink: "#174ea6" },
        success: { DEFAULT: "#17684a", bg: "#e8f7f0", border: "#b9ddce" },
        warning: { DEFAULT: "#8a5a11", bg: "#fff4dc", border: "#f3d7a6" },
        dark: "#172033",
      },
      borderRadius: { card: "8px", panel: "16px" },
      boxShadow: {
        card: "0 16px 36px rgba(25,47,80,0.06)",
        elevated: "0 22px 56px rgba(15,23,42,0.08)",
        panel: "0 24px 52px rgba(15,23,42,0.1)",
      },
    },
  },
  plugins: [],
};
export default config;
`;
  S["app/globals.css"] =
`@import url("https://cdn.jsdelivr.net/gh/orioncactus/pretendard@1.3.9/dist/web/static/pretendard.min.css");
@tailwind base;
@tailwind components;
@tailwind utilities;

:root { color-scheme: light; --accent: #2779eb; --accent-strong: #1f6feb; }
/* 브랜드 accent 오버라이드 슬롯(프로젝트별). 기본 = 정갈한 SaaS 블루. */
[data-theme="ci-blue"] { --accent: #2779eb; --accent-strong: #1f6feb; }
body { @apply bg-surface-muted text-ink antialiased; word-break: keep-all; }
`;
  // 브랜드 상수(dev-doc §8ⓑ) — 서비스명·태그라인·SSO 도메인 1곳. 전부 계약에서 도출(하드코딩 없음).
  S["lib/brand.ts"] =
`// 서비스명·도메인 단일 정의(dev-doc §8ⓑ). 전 화면이 이를 참조. (poc-forge S4가 spec.product·context에서 도출)
export const BRAND = ${JSON.stringify(brand.name)};
export const BRAND_TAGLINE = ${JSON.stringify(brand.tagline)};
export const EMAIL_DOMAIN = ${JSON.stringify(brand.emailDomain)};
`;
  // DB 시임(scaffold가 계약 고정) — schema.ts:SCHEMA_SQL, seed.ts:seedIfEmpty 를 요구
  S["lib/db.ts"] =
`// 로컬 SQLite(@libsql/client, 순수 JS/네이티브 컴파일 없음) → 배포 시 포터블(Turso/libsql).
import { createClient, type Client } from "@libsql/client";
import { mkdirSync, statSync, rmSync } from "node:fs";
import { SCHEMA_SQL } from "./schema";
import { seedIfEmpty } from "./seed";

try { mkdirSync("data", { recursive: true }); } catch {}

// PoC 데모 결정성: 시드는 SEED_NOW(오늘) 기준 상대 앵커(임박/지연 등)이라 날짜가 바뀌면 옛 절대날짜가 드리프트한다.
// 이전 날짜(로컬 자정 이전 mtime)에 만든 db는 삭제 → 오늘 기준으로 깨끗이 재시드(시간민감 상태가 실행일과 무관히 결정적).
try {
  const _st = statSync("data/${project}.db");
  const _mid = new Date(); _mid.setHours(0, 0, 0, 0);
  if (_st.mtimeMs < _mid.getTime()) rmSync("data/${project}.db", { force: true });
} catch {}

export const db: Client = createClient({ url: "file:data/${project}.db" });

let _ready: Promise<void> | null = null;
/** 최초 접근 시 스키마 DDL 실행 + 시드(멱등). 모든 도메인 쿼리 시작에서 await. */
export function ensureReady(): Promise<void> {
  if (!_ready) {
    _ready = (async () => {
      for (const stmt of SCHEMA_SQL) await db.execute(stmt);
      await seedIfEmpty(db);
    })();
  }
  return _ready;
}
`;
  S[".gitignore"] = `node_modules\n.next\n*.db\ndata/*.db\nnext-env.d.ts\n`;
  return S;
}

function writeApp(appDir, rel, content) {
  const abs = join(appDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

// ── 프롬프트 조립 ─────────────────────────────────────────────────────────────
const VISUAL = new Set(["ui", "layout", "page"]);
function buildPrompt(tpl, item, ctx) {
  const { devDoc, up, priorSurface, selectorsJson, fix } = ctx;
  // FILE_SPEC
  let fileSpec = "";
  if (item.kind === "api") fileSpec = `# 이 파일이 구현할 엔드포인트(server-spec)\n\`\`\`json\n${JSON.stringify(item.spec, null, 2)}\n\`\`\``;
  else if (item.kind === "page") fileSpec = `# 이 파일이 구현할 화면(page-spec)\n\`\`\`json\n${JSON.stringify(item.spec, null, 2)}\n\`\`\``;
  else if (item.kind === "domain") fileSpec = `# 이 모듈의 역할\n${item.spec}`;
  else if (item.kind === "layout") fileSpec = `# 전역 네비게이션 IA(page-spec)\n\`\`\`json\n${JSON.stringify(item.spec, null, 2)}\n\`\`\``;

  // CONTRACTS (kind별)
  let contracts = "";
  if (item.kind === "data-schema" || item.kind === "domain")
    contracts += `## schema.json\n\`\`\`json\n${JSON.stringify(up.schema, null, 2)}\n\`\`\`\n`;
  if (item.kind === "domain") // api는 자기 엔드포인트가 FILE_SPEC에 있으므로 full server-spec 불필요(프롬프트 슬림 = 속도↑)
    contracts += `## server-spec.json (서버 로직)\n\`\`\`json\n${JSON.stringify(up.serverSpec, null, 2)}\n\`\`\`\n`;
  if (item.kind === "data-seed") {
    const assetsBlock = (up.dataAssets || [])
      .map((a) => `## 시드 원본: ${a.file} (실데이터 — 그대로 사용)\n\`\`\`\n${a.content}\n\`\`\`\n`).join("");
    contracts += assetsBlock + `## schema.json\n\`\`\`json\n${JSON.stringify(up.schema, null, 2)}\n\`\`\`\n`;
  }
  if (item.kind === "page")
    contracts += `## 호출 가능한 API 엔드포인트(mutation은 여기로 fetch)\n${(up.serverSpec.endpoints || []).map((e) => `- ${e.method} ${e.path} — ${e.purpose}`).join("\n")}\n`;

  const surfaceBlock = priorSurface ? `# 실제 export 표면 (여기 있는 이름만 \`@/...\`에서 import)\n\`\`\`ts\n${priorSurface}\n\`\`\`` : "";
  const selBlock = VISUAL.has(item.kind) && selectorsJson
    ? `# 셀렉터 계약 (이 data-testid를 해당 요소에 실제로 부여 — S5 검수용)\n\`\`\`json\n${selectorsJson}\n\`\`\``
    : "";
  const fixBlock = fix
    ? `# ★ 빌드 에러 수정 모드 — 아래 에러만 고쳐 **완전한 파일 전체**를 다시 출력(다른 동작 보존, 새 버그 금지)\n[빌드 에러]\n${fix.err}\n[현재 파일 내용]\n${fix.content}`
    : "";

  return tpl
    .replaceAll("{{PATH}}", item.path)
    .replaceAll("{{KIND_GUIDE}}", KIND_GUIDES[item.kind] || "")
    .replaceAll("{{FILE_SPEC}}", fileSpec)
    .replaceAll("{{EXPORT_SURFACE}}", surfaceBlock)
    .replaceAll("{{SELECTORS}}", selBlock)
    .replaceAll("{{FIX_BLOCK}}", fixBlock)
    .replaceAll("{{DEV_DOC}}", devDoc)
    .replaceAll("{{CONTRACTS}}", contracts);
}

async function genFile(tpl, item, ctx, tries = 2) {
  const prompt = buildPrompt(tpl, item, ctx);
  let lastErr;
  for (let n = 0; n < tries; n++) { // 주입/비코드/빈 출력이면 즉시 재생성(LLM 비결정적 → 재시도로 회복). 빌드 루프 대기 X.
    try {
      const content = cleanFileOutput(await callLLM(prompt));
      if (!content || content.length < 20) throw new Error("빈 출력");
      // 비코드 방어: 순수 산문·모델 거부 응답은 export/import가 없음 → 거부. 도메인 리터럴 오탐 없음.
      if (!/\b(export|import)\b/.test(content)) throw new Error("코드 아님(export/import 없음)");
      // 주입 방어: 정상 코드엔 절대 없는 주입 마커만(도메인 식별자 TaskComplete·"I can't help" 오탐 회피 = 도메인 불가지).
      if (/<\/?system-reminder\b|end your turn with\b/i.test(content)) throw new Error("프롬프트 주입 출력 감지");
      return content;
    } catch (e) { lastErr = e; if (n + 1 < tries) console.error(`[s4]   ↻ 재생성(${item.path}): ${e.message}`); }
  }
  throw lastErr;
}

// ── 빌드 ──────────────────────────────────────────────────────────────────────
function sh(cmd, cwd, { timeout = 0 } = {}) {
  return new Promise((res) => {
    const child = spawn(cmd, { shell: true, cwd });
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    let to = timeout ? setTimeout(() => { try { child.kill(); } catch {} }, timeout) : null;
    child.on("error", (e) => { if (to) clearTimeout(to); res({ code: -1, out: out + "\n" + e.message }); });
    child.on("close", (code) => { if (to) clearTimeout(to); res({ code, out }); });
  });
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const project = args.find((a) => !a.startsWith("-"));
  const noBuild = args.includes("--no-build");
  const buildOnly = args.includes("--build-only");
  const skipExisting = args.includes("--skip-existing"); // resume: 이미 있는 파일은 유지, 없는 것만 생성
  const maxRepair = parseInt((args.find((a) => a.startsWith("--max-repair=")) || "").split("=")[1] || "3", 10);
  const maxFiles = parseInt((args.find((a) => a.startsWith("--max-files=")) || "").split("=")[1] || "0", 10) || Infinity; // 마이크로배치(자원 안전)
  const layersArg = (args.find((a) => a.startsWith("--layers=")) || "").split("=")[1];
  const regen = new Set(buildOnly ? [] : (layersArg ? layersArg.split(",").map((s) => s.trim().toUpperCase()) : ["A", "B", "C", "D", "E"]));

  const projectDir = resolveProjectDir(project);
  const proj = basename(projectDir);
  const appDir = join(projectDir, "app");
  const up = loadUpstream(projectDir);
  const brand = deriveBrand(up); // {name, tagline, emailDomain} — 전부 계약에서 도출
  const tpl = readFileSync(join(SKILL_DIR, "prompt-codegen.md"), "utf8");
  const selectorsJson = JSON.stringify(up.acceptance?.selectors || {}, null, 2);
  const plan = buildFilePlan({ serverSpec: up.serverSpec, pageSpec: up.pageSpec });
  const allVarPaths = plan.layers.flatMap((L) => L.files.map((f) => f.path));
  const itemByPath = new Map(plan.layers.flatMap((L) => L.files.map((f) => [f.path, f])));

  console.error(`[s4] load: dev-doc + page/schema/server/acceptance + spec/context · 브랜드=${brand.name} · 시드자산 ${up.dataAssets.length}`);
  for (const w of stalenessWarnings(projectDir)) console.error(`[s4][stale] ${w}`);
  console.error(`[s4] 플랜: A ${plan.layers[0].files.length} · B ${plan.layers[1].files.length} · C(api) ${plan.layers[2].files.length} · D ${plan.layers[3].files.length} · E(page) ${plan.layers[4].files.length} (route ${plan.routeFiles.length})`);
  // 도메인 불가지: 레이어 B(도메인 모듈)는 server-spec.modules[]에서 도출 — 비어있으면 계약 미비(S3 재실행 필요).
  if (regen.has("B") && plan.layers[1].files.length === 0)
    throw new Error("server-spec.json에 modules[]가 없음/비어있음 — 도메인 모듈을 도출할 수 없습니다. S3(design) 재실행으로 modules[]를 생성하세요.");
  // 플랜 무결(계약 대비): null 매핑으로 조용히 빠지는 엔드포인트/페이지 loud fail
  const pc = validatePlanCoverage(up.serverSpec, up.pageSpec);
  if (!pc.ok) throw new Error("파일 플랜 커버리지 실패(silent-drop):\n  - " + pc.errors.join("\n  - "));

  const log = { project: proj, generated: [], failed: [], build: null };

  // 1) 스캐폴딩
  if (!buildOnly) {
    const S = scaffold(proj, brand);
    for (const [rel, content] of Object.entries(S)) writeApp(appDir, rel, content);
    console.error(`[s4] 스캐폴딩 ${Object.keys(S).length}개 (LLM 0)`);
  }

  // 2) 레이어드 코드젠 (export 표면 전파)
  const SCAFFOLD_SURFACE =
    "// @/lib/db\nexport const db: Client\nexport function ensureReady(): Promise<void>\n" +
    "// @/lib/brand\nexport const BRAND: string\nexport const BRAND_TAGLINE: string\nexport const EMAIL_DOMAIN: string";
  const SEQUENTIAL = new Set(["A", "B", "D"]); // 내부 상호참조 → 순차(앞 파일 표면을 뒤가 봄)
  let accumSurface = SCAFFOLD_SURFACE;
  let remaining = maxFiles; // 이번 호출에서 생성할 신규 파일 예산(마이크로배치)

  for (const layer of plan.layers) {
    if (regen.has(layer.id) && layer.files.length) {
      console.error(`[s4] 레이어 ${layer.id} — ${layer.files.length}개 생성 (${SEQUENTIAL.has(layer.id) ? "순차" : "병렬×3"})…`);
      const ctxBase = { devDoc: up.devDoc, up, selectorsJson };
      if (SEQUENTIAL.has(layer.id)) {
        let localSurface = accumSurface;
        for (const item of layer.files) {
          if (skipExisting && readIf(join(appDir, item.path)).trim().length > 20) {
            localSurface += "\n" + surfaceOf(appDir, item.path);
            console.error(`[s4]   • skip(존재) ${item.path}`); continue;
          }
          if (remaining <= 0) { console.error(`[s4]   • 예산소진 보류 ${item.path}`); continue; }
          try {
            const content = await genFile(tpl, item, { ...ctxBase, priorSurface: localSurface });
            writeApp(appDir, item.path, content);
            log.generated.push(item.path); remaining--;
            localSurface += "\n" + surfaceOf(appDir, item.path);
            console.error(`[s4]   ✓ ${item.path} (${content.length}B)`);
          } catch (e) { log.failed.push({ path: item.path, error: String(e.message || e) }); console.error(`[s4]   ✗ ${item.path}: ${e.message}`); }
        }
      } else {
        const avail = skipExisting ? layer.files.filter((f) => readIf(join(appDir, f.path)).trim().length <= 20) : layer.files;
        const skipped = layer.files.length - avail.length;
        if (skipped) console.error(`[s4]   • skip(존재) ${skipped}개`);
        const todo = remaining === Infinity ? avail : avail.slice(0, Math.max(0, remaining));
        if (todo.length < avail.length) console.error(`[s4]   • 예산 ${remaining}개만 생성(나머지 ${avail.length - todo.length}개 다음 호출)`);
        remaining -= todo.length;
        const res = await runPool(todo, 3, async (item) => {
          const content = await genFile(tpl, item, { ...ctxBase, priorSurface: accumSurface });
          writeApp(appDir, item.path, content);
          console.error(`[s4]   ✓ ${item.path} (${content.length}B)`);
          return item.path;
        });
        res.forEach((r, i) => { if (r && r.error) { log.failed.push({ path: todo[i].path, error: r.error }); console.error(`[s4]   ✗ ${todo[i].path}: ${r.error}`); } else log.generated.push(r); });
      }
    }
    // 이 레이어의 on-disk 표면을 누적(재생성 안 한 레이어도 기존 파일 표면 반영)
    accumSurface += "\n" + layer.files.map((f) => surfaceOf(appDir, f.path)).filter(Boolean).join("\n");
  }
  writeApp(appDir, ".s4-build-log.json", JSON.stringify(log, null, 2));
  if (log.failed.length) console.error(`[s4][warn] 생성 실패 ${log.failed.length}개 — 빌드/자동복구에서 재시도`);

  if (noBuild) {
    console.error(`[s4] --no-build: npm/빌드 생략 (생성 ${log.generated.length}개). 빌드는: node run.mjs ${proj} --build-only`);
    return;
  }

  // 3) npm install + next build + 자동복구 루프
  console.error("[s4] npm install…");
  const inst = await sh("npm install", appDir, { timeout: 600000 });
  if (inst.code !== 0) { console.error("[s4] npm install 실패:\n" + inst.out.slice(-2000)); process.exit(1); }

  let build = null;
  // Windows에서 stale `.next` 위 재빌드 = `.next\export\500.html` rename ENOENT(errno -4058) flake → 매 시도 전 .next 삭제로 예방.
  const isTransientFsError = (s) => /errno:\s*-?4058|\bEPERM\b|\bENOTEMPTY\b|500\.html/i.test(s || "") || (/\brename\b/i.test(s || "") && /\bENOENT\b/i.test(s || ""));
  for (let attempt = 0; attempt <= maxRepair; attempt++) {
    try { rmSync(join(appDir, ".next"), { recursive: true, force: true }); } catch {}
    console.error(`[s4] next build (시도 ${attempt + 1}/${maxRepair + 1})…`);
    const r = await sh("npm run build", appDir, { timeout: 600000 });
    build = { ok: r.code === 0, code: r.code, log: r.out };
    if (build.ok) { console.error("[s4]   ✓ next build 그린"); break; }
    console.error("[s4]   ✗ 빌드 실패");
    if (attempt === maxRepair) break;
    const bad = parseBuildErrorFiles(r.out, allVarPaths);
    if (!bad.length) {
      // 코드 파일을 못 특정 — 일시적 FS 오류(.next rename 등)면 재생성 없이 그대로 재빌드, 아니면 중단
      if (isTransientFsError(r.out)) { console.error("[s4] 일시적 FS 오류 감지(.next rename 등) — 재생성 없이 재빌드"); continue; }
      console.error("[s4] 빌드 에러에서 가변 파일을 특정 못함 — 자동복구 중단"); break;
    }
    console.error(`[s4] 자동복구: ${bad.length}개 파일 재생성 — ${bad.join(", ")}`);
    const errDigest = r.out.slice(-4000);
    await runPool(bad, 3, async (rel) => {
      const item = itemByPath.get(rel);
      if (!item) return;
      const cur = readIf(join(appDir, rel));
      const content = await genFile(tpl, item, { devDoc: up.devDoc, up, selectorsJson, priorSurface: accumSurface, fix: { err: errDigest, content: cur } });
      writeApp(appDir, rel, content);
      console.error(`[s4]   ↻ ${rel}`);
    });
  }
  log.build = { ok: build?.ok, code: build?.code };
  writeApp(appDir, ".s4-build-log.json", JSON.stringify(log, null, 2));

  // 4) 가드
  const bg = validateBuildGreen(build);
  if (!bg.ok) {
    writeApp(appDir, ".s4-build-error.log", build?.log || "");
    console.error("[s4] 가드 실패 — " + bg.errors.join(" "));
    console.error("   빌드 로그: app/.s4-build-error.log (마지막 부분):\n" + (build?.log || "").slice(-1500));
    process.exit(1);
  }
  // named-export/module 드리프트: next build는 존재모듈의 *없는 named export* 를 warning으로만 취급(빌드 실패 X).
  //   export 표면 전파의 안전망으로 tsc가 TS2305(없는 export)·TS2307(없는 모듈)만 잡아 하드 실패시킨다(다른 타입 nit은 무시=behavior는 S5).
  const tsc = await sh("npx tsc --noEmit", appDir, { timeout: 300000 });
  const driftLines = (tsc.out || "").split(/\r?\n/).filter((l) => /error TS2305|error TS2307/.test(l));
  if (driftLines.length) {
    writeApp(appDir, ".s4-drift.log", tsc.out || "");
    console.error(`[s4]   ✗ import/export 드리프트(TS2305/2307) ${driftLines.length}건 (전체: app/.s4-drift.log):`);
    for (const l of driftLines.slice(0, 12)) console.error("     " + l.trim());
    process.exit(1);
  }
  console.error("[s4]   ✓ import/export 드리프트 없음(TS2305/2307)");

  const guards = [
    ["필수 파일", validateRequiredFiles(appDir)],
    ["오배치 라우트/페이지", validateStrayRoutes(appDir)],
    ["라우트 커버리지", validateRouteCoverage(appDir, plan.routeFiles)],
    ["셀렉터 계약", validateSelectorCoverage(appDir, up.acceptance)],
  ];
  let hardFail = false;
  for (const [name, g] of guards) {
    if (g.ok) console.error(`[s4]   ✓ ${name}${g.stats ? ` (${g.stats.covered}/${g.stats.wanted})` : ""}`);
    else { hardFail = true; console.error(`[s4]   ✗ ${name}: ${g.errors.join(" ")}`); }
  }
  if (hardFail) { console.error("[s4] 커버리지 가드 실패 — 위 항목 보완 필요(관련 파일 재생성 후 --build-only)"); process.exit(1); }

  // 산출물 도장 + 커밋
  const meta = stampMeta({ stage: "s4-build", inputsFingerprint: fingerprint([up.devDoc, JSON.stringify(up.pageSpec), JSON.stringify(up.serverSpec)]) });
  writeApp(appDir, ".s4-meta.json", JSON.stringify(meta, null, 2));
  const msg = `[${proj}] s4 build · 파일 ${log.generated.length} · 빌드 그린 · route ${plan.routeFiles.length}·page ${plan.pageFiles.length}`;
  const commit = commitRun(msg);
  console.error("");
  console.error(`[s4] OK → runs/${proj}/app/ (빌드 그린)`);
  console.error(commit.committed ? `[s4] git: 커밋됨 — ${msg}` : `[s4] git: skip (${commit.reason})`);
  console.error("✅ S4 개발 완료. 게이트: 빌드 그린 통과 → S5(QA)로. (앱 확인: cd app && npm run dev)");
}

main().catch((e) => { console.error("[s4] ERROR:", e.message); process.exit(1); });
