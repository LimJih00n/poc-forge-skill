---
name: s2-plan
description: poc-forge 파이프라인의 S2(기획). S1의 이해(context.json)를 받아 "엑셀로 한 줄씩 관리할" 수준으로 잘게 쪼갠 세부 기능정의서(spec.json + features.md)와 내러티브 PRD(prd.md)를 만든다. BigShift 실제 납품 기능정의서 컬럼 포맷. 행-granular·근거링크·상세내용·acceptanceHint를 코드 가드로 강제. 단독 실행 가능한 컴포넌트 스킬.
---

# S2 · 기획 (plan)

poc-forge 5컴포넌트의 두 번째. S1이 정리한 이해를 바탕으로 **세부 기획**을 한다. 산출물 2종 = ① **기능정의서**(무엇을 만들지, 행 단위) ② **PRD**(왜·누구를·어떻게), 각각 사람용 + AI 구조화. "무엇을 만들지"까지만 — 화면 디자인·DB·서버는 S3.

## 핵심 원칙 — "되게 자세히"를 안전하게
- **행 granularity**: BigShift 실제 기능정의서처럼 버튼·상태·검증·상호작용 하나하나를 **개별 기능 행**으로 잘게. 각 행 = 견적·QA 가능한 최소 단위 + 정밀 상세내용.
- **자세함 ≠ 지어내기**: 각 항목 `status`(confirmed 소스근거 / proposed 도메인상식+가정명시 / open 미정) + 근거. 가드가 근거·계층·상세내용·acceptanceHint를 **코드로 강제**.

## 입출력 계약
- **IN**: `runs/<project>/context.json` (+ `understanding.md`, `sources/` 원자료 전체) ← S1
- **OUT**:
  - `spec.json` — AI 구조화 (features[]·nfr·businessRules·personas·scenarios·scope·openQuestions·glossary + product). S3가 소비하는 계약.
  - `features.md` — 사람용 **기능정의서 표**(BigShift 컬럼: 구분/대분류/중분류/기능/상세내용/화면후보/참조데이터/범위/As-is/우선순위/상태/근거).
  - `prd.md` — 사람용 **내러티브 PRD**(배경·핵심메시지·사용자·범위·플로우·NFR·정책·우선순위·성공기준·오픈이슈).

## 내부 단계 (claude 2콜 + 결정적 렌더)
1. **spec 생성** — context.json + 원자료 전체 → `spec.json`. 두 방식:
   - **단일콜(기본, `prompt-spec.md`)** — 한 번에 전체 spec. 잘림 감지 + 재시도(`lib/llm.mjs generateJson`) 3회.
   - **★ 청크(`--chunked`, `prompt-spec-plan.md`+`prompt-spec-enrich.md`)** — S4/S5식 **누적/append**. 큰 프로젝트(features 100행+ ≈ 출력한도 근접)에서 잘림을 구조적으로 회피 + 중간 사망 시 완료분 보존. → **"아웃라인-완결 → 대분류별 상세화"** (아래).
2. **가드** (`guard.mjs`, 코드) — 계층(구분/대분류/중분류/기능)·상세내용 비면 fail · 근거 무결(실존 파일) · confirmed는 근거+acceptanceHint 필수 · 커버리지(warn) · S1 오픈질문 승계(warn). 청크는 추가로 `validateSpecPlan`(아웃라인)·`validateEnrichedGroup`(1:1 상세화)·`featureCoverage`(조용한 드롭 hard).
3. **PRD 서술** (`prompt-prd.md`, claude) — spec.json + context → `prd.md` 프로즈(스펙 벗어난 기능 창작 금지).
4. **features.md 렌더** (코드) — spec.json에서 결정적 표 렌더(드리프트 0).

### --chunked 방식 상세 ("아웃라인-완결 → 대분류별 상세화 + jsonl 체크포인트")
청크화의 진짜 위험 = **커버리지 후퇴**(쪼개다 features가 조용히 줆). 이를 없애는 설계:
1. **plan 콜 1회** (`prompt-spec-plan.md`) — 뼈대 전부(product·personas·scenarios·scope·nfr·businessRules·openQuestions·glossary) + **features는 아웃라인만**(구분/대분류/중분류/기능/status/priority). **100행 taxonomy를 한 응집 콜로 결정 = 커버리지 고정**(작아서 안 잘림). → `.s2-plan.json`.
2. **대분류별 상세화 루프** (`prompt-spec-enrich.md`) — 각 (구분·대분류) 그룹의 아웃라인 행을 **풀 상세 행으로 1:1 확장**(id 보존) → `.s2-features.jsonl` append. 각 배치 작음 → 상세히·안 잘림.
3. **조립 + 가드** — jsonl 읽어 id dedup·plan순서 → spec.json. `validateSpec`(전체) + `featureCoverage`(모든 아웃라인 id 존재·대분류별 ≥1 = **조용한 드롭 hard 차단**).
- **체크포인트/resume**: 중간 사망 시 완료 그룹은 `.s2-features.jsonl`에 보존. `--chunked --resume`이 기존 `.s2-plan.json` 재사용 + 완료 그룹 skip + 나머지만 채움(S4식). `--chunked`(resume 없음)는 fresh = plan 재생성·jsonl 폐기.

## 실행법
```bash
node skills/s2-plan/run.mjs gearloan                    # 단일콜(기본)
node skills/s2-plan/run.mjs gearloan --chunked          # 청크(큰 프로젝트 권장) — fresh
node skills/s2-plan/run.mjs gearloan --chunked --resume # 청크 이어하기(중간 사망 후)
POC_FORGE_LLM_CMD="node fake.mjs" node skills/s2-plan/run.mjs gearloan   # LLM 스왑
```
- 선행: S1이 `context.json`을 만들어 뒀어야 함(없으면 에러).
- 성공: `spec.json`+`features.md`+`prd.md` 생성, git 자동커밋, 통계 로그. 디버그 원본 = `.s2-spec-raw.txt`(단일콜) / `.s2-plan-raw.txt`·`.s2-enrich-raw.txt`·`.s2-features.jsonl`·`.s2-plan.json`(청크, 전부 `.s2-` 접두라 gitignore).
- **주의(라이브 검증)**: `--chunked`는 결정적 코어(그룹핑·조립·resume·커버리지)를 단위검증 + mock LLM E2E로 확인했으나, **실 claude 프롬프트(plan/enrich) 품질은 실호스트 라이브 미검증**. 청크 출력 품질 ≥ 단일콜 확인 전까지 **단일콜이 기본**.

## 원칙 (DESIGN.md 준수)
- **전체 데이터 다 넣고, 규칙 적게, 모델 신뢰** — context.json + 원자료 전량 주입, truncate 없음.
- **extract not originate** — BigShift 실제 기능정의서 컬럼 포맷·granularity에 정렬. S1 assets를 `참조데이터`로 링크.
- **가드는 코드로** — 근거·계층·상세·acceptanceHint는 `guard.mjs`가 강제.
- **얇게·도메인 불가지** — 특정 도메인 하드코딩 없음. `lib/version.mjs` 공용 재사용.
