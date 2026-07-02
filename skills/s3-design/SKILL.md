---
name: s3-design
description: poc-forge 파이프라인의 S3(설계) — 가장 무거운 단계. S1·S2 산출(context/spec/prd)과 원자료 전부를 받아 ① UI/UX 화면 설계(page-spec.json) + gpt2 프론트 데모 화면(screens/*.png)을 만들고 [내부 화면 게이트] ② 승인된 화면을 역산해 DB 스키마·서버 로직/API·테스트 설계·개발 문서를 만든다. 화면 역산·커버리지·셀렉터 계약을 코드 가드로 강제. 단독 실행 가능한 컴포넌트 스킬(2 페이즈).
---

# S3 · 설계 (design)

poc-forge 5컴포넌트의 세 번째이자 **가장 무거운 단계**. S2가 "무엇을 만들지"(기능정의서)를 정했다면, S3는 "**어떻게 생겼고 어떻게 동작하는지**"를 화면-first로 설계하고, 그 화면을 **역산**해 DB·서버·테스트·개발문서까지 잠근다. S4(개발)는 이 산출물만 보고 실제 앱을 만든다.

## 2 페이즈 + 내부 화면 게이트
```
phase ui      화면 설계 + gpt2 데모 화면        →  ✋ "이 화면이면 돼요?"  →  phase design
phase design  (승인된 화면 역산) DB·서버·테스트·개발문서
```
- **화면 역산 원칙**: DB·서버·test는 기획(spec)이 아니라 *승인된 화면(page-spec)* 을 역산해서 만든다. (화면 확정 전 스키마를 뽑으면 "spec이 완벽하다"는 가정을 깐다.)
- **게이트 = 페이즈 경계**: phase ui가 화면을 만들고 멈춘다. 사람이 `screens/`·`page-spec.md`를 보고 승인하면 `--phase=design`을 실행한다(그 실행 = 승인 행위). 화면 수정은 phase ui 재실행(전체 재도출).

## 입출력 계약
- **IN**: `runs/<project>/` 의 `context.json`·`understanding.md`(S1) + `spec.json`·`features.md`·`prd.md`(S2) + `sources/` 원자료 **전부**. (누적 맥락 — 직전만이 아니라 이전 전부 + 실데이터를 본다.)
- **OUT (phase ui)**: `page-spec.json`(기계: ia/pages{url,권한,필드,상태,액션,features매핑,gpt2Prompt}/**flows**{화면 전이 여정, S2 시나리오 근거}) + `page-spec.md`(사람용 게이트 리뷰 — IA·플로우·화면) + `screens/*.png`(gpt2 목업, 전 화면).
- **OUT (phase design)**: `schema.json`(DB) + `server-spec.json`(엔드포인트/로직) + `acceptance.json`(테스트+셀렉터 계약) + `dev-doc.md`(구현 가이드, S4가 읽음).

## 커버리지 가드 체인 (silent-drop 방지 — 코드로 강제)
- confirmed 기능 → **어떤 화면엔가 매핑** (page-spec, phase ui). 미매핑 시 실패.
- endpoint.tables ⊂ 실존 테이블 · endpoint.features ⊂ 실존 기능 (server, 지어냄 방지).
- confirmed 기능 → **테스트 ≥1** (acceptance, "test=바닥"). 미커버 시 실패.
- acceptance `assert`의 `data-testid` → `selectors`에 등재 = **셀렉터 계약**(S4가 부여, S5가 실행).

## --chunked (opt-in 청크 생성 — 큰 프로젝트 견고화)
기본 경로는 각 산출을 **단일콜 + 잘림 감지·재시도**(`lib/llm.mjs generateJson`)로 만든다. 큰 프로젝트(server 29엔드포인트·acceptance 64테스트 등 출력 한도 근접)에서 잘림을 **구조적으로 회피**하고 중간 사망 시 완료분을 보존하려면 `--chunked`(opt-in). 기본 경로는 안 건드리고 `--chunked`일 때만 분기한다. (S2 `--chunked`와 동일 원칙.)
- **"아웃라인-완결 → 그룹별 상세화 + jsonl 체크포인트"**: plan 콜 1회가 **전체 목록·커버리지를 한 응집 콜로 고정**(작아서 안 잘림) → enrich가 그룹별로 **1:1 확장**(각 배치 작음) → 조립 시 `coverageFloor`가 **조용한 드롭을 hard 차단**. 청크화의 진짜 위험(커버리지 후퇴)을 이 구조가 없앤다. **size-adaptive**: 그룹이 적으면 배치도 적음(낭비 최소).
- **4개 산출 각각 지배적 배열을 청크**(plan 아웃라인 가드 + enriched 1:1 가드 2개씩, `guard.mjs`):
  - `page-spec.pages` — 그룹키 = url 첫 세그먼트(`/admin/x`→admin). ia·flows는 plan에 완전히. enrich가 layout·컴포넌트·필드·상태·액션·gpt2Prompt 채움. (phase ui: 조립된 `ps`로 fal 렌더·게이트는 공통.)
  - `schema.tables` — N개씩 배치(기본 6). relations는 plan에 완전히. enrich가 columns 채움.
  - `server.endpoints` — 그룹키 = `/api/` 뒤 리소스(예 loans). dataFlow·modules는 plan에 완전히. enrich가 in/out/logic 채움. 정책 커버리지(BR→endpoint.rules)는 **plan에서 고정**.
  - `acceptance.tests` — 그룹키 = `test.page`. 바닥 커버리지(confirmed→테스트≥1)는 **plan에서 고정**. enrich가 steps·assert·셀렉터 채움(그룹 selectors→조립 시 병합).
- **조립 후 기존 whole-가드 그대로 재사용**: `validatePageSpec`/`validateSchema`/`validateServerSpec`/`validateAcceptance` + `validateRuleCoverage` 교차검증 + `coverageFloor`. schema→server→acceptance 순서·`schemaStr`·`tableNames` 재사용·dev-doc(단일콜 유지) 무손상.
- **체크포인트/resume**: 중간 사망 시 완료 그룹은 `.s3-<x>.jsonl`에 보존. `--chunked --resume`이 기존 `.s3-<x>-plan.json` 재사용 + 완료 그룹 skip + 나머지만 채움. `--chunked`(resume 없음)는 fresh = plan 재생성·jsonl 폐기. 전부 `.s3-` 접두 → gitignore. (acceptance는 selectors 누적물 `.s3-acceptance-side.json` 추가.)

## gpt2 프론트 데모 화면
- claude가 화면별 `gpt2Prompt`(레이아웃·컴포넌트·실제 한국어 콘텐츠) 작성 → run.mjs가 **공통 디자인 프리픽스**(spec에서 도출한 브랜드/톤 + 피그마 시안 프레이밍 + 한국어·데스크톱 landscape + 브랜드 안전규칙)를 앞에 붙여 fal `openai/gpt-image-2`로 렌더 → 화면 세트 일관성.
- **image = 방향**(픽셀 복제 아님): S4는 목업을 레이아웃·비례·색 참고로만 쓰고, 콘텐츠 이미지는 placeholder, 브랜드는 spec 기준.

## 실행법
```bash
node skills/s3-design/run.mjs gearloan --phase=ui              # 화면 설계 + gpt2 렌더 → 게이트에서 멈춤
node skills/s3-design/run.mjs gearloan --phase=ui --no-images  # page-spec(설계)만, 렌더 생략(빠른 반복)
node skills/s3-design/run.mjs gearloan --phase=ui --images-only # 기존 page-spec 유지하고 이미지만 렌더(설계-먼저 워크플로)
# (사람이 screens/·page-spec.md 확인·승인)
node skills/s3-design/run.mjs gearloan --phase=design          # 역산: schema·server·acceptance·dev-doc
node skills/s3-design/run.mjs gearloan --phase=ui   --chunked  # (opt-in) page-spec 청크 — fresh
node skills/s3-design/run.mjs gearloan --phase=design --chunked          # (opt-in) schema/server/acceptance 청크 — fresh
node skills/s3-design/run.mjs gearloan --phase=design --chunked --resume # 청크 이어하기(중간 사망 후)
POC_FORGE_LLM_CMD="node fake.mjs" node skills/s3-design/run.mjs gearloan --phase=ui   # LLM 스왑(배선/가드 테스트)
```
- 선행: S1(`context.json`)·S2(`spec.json`)가 있어야 함. FAL_KEY는 `bigshift/.env`에서 로드(없으면 목업만 건너뜀, 비치명).
- 디버그 원본: `.s3-*-raw.txt`. 청크 산출물 = `.s3-<x>-plan.json`·`.s3-<x>.jsonl`·`.s3-<x>-{plan,enrich}-raw.txt`(전부 `.s3-` 접두라 gitignore).
- **주의(라이브 검증)**: `--chunked`는 결정적 코어(그룹핑·조립·resume·커버리지·8개 가드)를 단위검증 + mock LLM E2E(phase ui·design 완주)로 확인했으나, **실 claude 프롬프트(plan/enrich 8종) 품질은 실호스트 라이브 미검증**. 청크 출력 품질 ≥ 단일콜 확인 전까지 **단일콜이 기본**.

## 원칙 (DESIGN.md 준수)
- **전체 데이터 다 넣고, 규칙 적게, 모델 신뢰** — S1·S2 산출 + 원자료 전량 주입, truncate 없음.
- **완전 순차 + 화면 역산** — 역산 4콜은 각각 앞 단계 산출(page-spec→schema→server→acceptance→dev-doc)을 근거로.
- **test = 바닥이지 천장 아님** — acceptance는 우회방지 최소선, 구현은 전체 맥락으로.
- **가드는 코드로** — 커버리지·정합·셀렉터 계약은 `guard.mjs`가 강제. **얇게·도메인 불가지** — 브랜드/톤도 spec에서 도출, 하드코딩 없음. `lib/version.mjs` 공용 재사용.
