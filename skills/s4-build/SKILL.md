---
name: s4-build
description: poc-forge 파이프라인의 S4(개발) — S3 설계(dev-doc·page-spec·schema·server-spec·acceptance·screens)를 받아 실제로 동작하는 Next.js(App Router)+SQLite 앱을 만든다. 결정적 스캐폴딩 + 레이어드 코드젠(스키마/도메인/API/전역chrome/페이지, export 표면 전파로 드리프트 방지) + next build 그린 자동복구 루프 + 코드 가드(빌드그린·셀렉터 계약·라우트 커버리지). 목업이 아니라 작동(필터·2단계승인·상태전이·임박/지연·강제반납이 진짜). 단독 실행 가능한 컴포넌트 스킬.
---

# S4 · 개발 (build)

poc-forge 5컴포넌트의 네 번째. S3가 "어떻게 생겼고 어떻게 동작하는지"를 **설계**했다면, S4는 그 설계를 **실제로 돌아가는 앱**으로 만든다. dealcatch가 "이렇게 만들 겁니다"(정적 목업)까지라면, poc-forge는 **"이렇게 *돌아갑니다*"**까지 — 데이터바인딩·필터·내비·정책 검증이 진짜 작동하는 Next.js 앱. **목업이 아니라 작동.**

## 입출력 계약
- **IN**: `runs/<project>/` 의 `dev-doc.md`(구현 가이드 = 1급 참고) · `page-spec.json` · `schema.json` · `server-spec.json` · `acceptance.json`(셀렉터 계약) · `screens/*.png`(방향 참고) + S1·S2 전부(`context.json`·`spec.json`) + `sources/` 실데이터(시드).
- **OUT**: `runs/<project>/app/` (Next.js App Router 프로젝트) + **빌드 그린**(`next build` exit 0).
- **gate(코드가드)**: **빌드 그린 없이 S5 진입 금지.**

## 내부 단계 (레이어드 + 파일단위 병렬)
```
0 로드      S1~S3 전부 + 원자료(CSV) — truncate 없음
1 스캐폴딩  (LLM 0) package.json·config·globals.css·lib/db.ts·lib/brand.ts     ← 결정적 보일러플레이트
2 코드젠     레이어 배리어로 export 표면 전파(드리프트 방지):
   Ⓐ data    lib/enums.ts → schema.ts → seed.ts        (스키마·시드 = export 표면의 뿌리)
   Ⓑ domain  lib/policy·loans·overdue·due-soon·auth·session·equipment·dashboard·approvals·history·notifications·csv  (BR의 심장)
   Ⓒ api     app/api/**/route.ts   (server-spec 1:1, method별 핸들러)
   Ⓓ chrome  app/layout.tsx(전역 chrome 단독 소유) + components/ui.tsx(공용 프리미티브)
   Ⓔ pages   app/**/page.tsx   (page-spec 역산 + 셀렉터 계약 부여)
3 빌드 검증  npm install → next build → 실패 시 에러를 지목 파일에 피드백해 fix(자동복구 루프, 최대 N회)
4 가드      빌드그린(하드게이트) · 셀렉터 계약 커버리지 · 엔드포인트↔라우트 · 필수파일
```
- **드리프트 방지 핵심**: lib(스키마/enum)를 **먼저** 생성해 그 실제 export 표면을 하류 레이어에 전달 → 존재하지 않는 export를 import하는 빌드 깨짐을 예방(dev-doc §8ⓓ). 각 레이어는 앞 레이어의 실제 export 시그니처를 보고 생성.
- **test = 바닥이지 천장 아님**: acceptance 61건은 우회방지 최소선. 구현은 dev-doc·page-spec·spec 전체 맥락으로(teaching-to-test 금지).
- **화면 이미지 = 방향**: `screens/*.png`는 레이아웃·톤 참고지 픽셀 정답 아님. "이 섹션엔 뭐가 필요한가"를 page-spec·schema·server에서 도출해 **통일된 공용 컴포넌트 시스템** 위에 화면 구성(전역 chrome은 `app/layout.tsx` 단독).

## 커버리지 가드 (silent-drop 방지 — 코드로 강제)
- **빌드 그린**: `next build` exit 0 — 하드게이트, 실패 시 S5 진입 금지.
- **셀렉터 계약**: `acceptance.json.selectors`의 모든 `data-testid`가 생성 코드에 실제로 존재(S5가 이걸로 검수). 미부여 시 실패.
- **라우트 커버리지**: server-spec의 모든(비 MIDDLEWARE) 엔드포인트에 대응 `route.ts` 존재.
- **필수 파일**: package.json·app/layout.tsx·app/page.tsx·lib/schema.ts·lib/db.ts.

## 실행법
```bash
node skills/s4-build/run.mjs gearloan                    # 전체: 스캐폴딩 → 코드젠 → 빌드+자동복구 → 가드
node skills/s4-build/run.mjs gearloan --no-build         # 코드젠만(빠른 반복), npm/빌드 생략
node skills/s4-build/run.mjs gearloan --build-only       # 코드젠 생략, 기존 app/ 빌드+자동복구+가드만
node skills/s4-build/run.mjs gearloan --layers=A,B       # 지정 레이어만 재생성
node skills/s4-build/run.mjs gearloan --skip-existing    # resume: 이미 있는 파일 유지, 없는 것만 생성
node skills/s4-build/run.mjs gearloan --max-files=5       # 마이크로배치(이번 호출 신규 N개만, 자원 안전)
node skills/s4-build/run.mjs gearloan --max-repair=2     # 자동복구 반복 상한(기본 3)
POC_FORGE_LLM_CMD="node fake.mjs" node skills/s4-build/run.mjs gearloan --no-build  # LLM 스왑(배선/가드 테스트)
```
- 선행: S3 산출(`dev-doc.md`·`page-spec.json`·`schema.json`·`server-spec.json`·`acceptance.json`)이 있어야 함.
- 앱 루트 = `runs/<project>/app/` (Next 프로젝트). DB = 로컬 SQLite(`@libsql/client`, 순수 JS/네이티브 컴파일 없음) → 배포 시 포터블.
- 디버그 원본: 각 파일 생성 로그 + `.s4-build-log.json`.

## 원칙 (DESIGN.md 준수)
- **전체 데이터 다 넣고, 규칙 적게, 모델 신뢰** — 각 파일 생성에 dev-doc 전문 + 해당 계약 + 앞 레이어 실제 export 표면 주입, truncate 없음.
- **실제 동작 보증** — 정적 목업 아님. 빌드 그린 + (S5) AI QA로 이중 보증.
- **가드는 코드로** — 빌드그린·셀렉터·라우트 커버리지는 `guard.mjs`가 강제. **얇게·도메인 불가지** — 파일 플랜은 계약(server-spec·page-spec)에서 결정적 도출, 하드코딩 없음. `lib/version.mjs` 공용 재사용·best-effort 자동커밋.
