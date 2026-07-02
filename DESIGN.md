# poc-forge — 설계 SSOT (Single Source of Truth)

작성: 2026-07-01 · 이 문서가 poc-forge의 **유일한 진실 원천.** 모든 스킬은 이 문서의 정체성·원칙·계약을 따른다.
전신(반면교사·참고): `../old-poc-pilot/` · 방향성 원문: `../sessionhandoff.md` · 교훈: `memory/poc-pilot.md`

---

## 0. 정체성 (흔들지 말 것)

**poc-forge = "계획 → *실제 돌아가는* 서비스".**

- 입력: dealcatch 제안서(rfp·목업·구현제안) **또는** 대화·요구·구조화 브리프.
- 출력: **돌아가는 Next.js 앱**(데이터바인딩·필터·내비가 진짜 작동) + AI QA 통과 + (선택) 납품문서·라이브 데모.
- **dealcatch가 "이렇게 만들 겁니다"(정적 목업)까지라면, poc-forge는 "이렇게 *돌아갑니다*"까지.** 이게 고유 가치. 목업이 아니라 **작동**.

---

## 1. 아키텍처 — 오케스트레이션 스킬 + 컴포넌트 스킬

```
poc-forge/                     ← 엄브렐러: "관장하는" 오케스트레이션 스킬
  DESIGN.md                    ← 이 문서 (SSOT)
  SKILL.md                     ← poc-forge 진입점 (오케스트레이터, 도메인 로직 0)
  orchestrator/                ← 얇은 엔진 (순서·게이트·가드·루프백 = 코드로 강제)
  skills/
    s1-understand/  SKILL.md + guard + prompt   ← 컴포넌트 스킬 (독립 실행 가능)
    s2-plan/        SKILL.md + guard + prompt
    s3-design/      SKILL.md + guard + prompt
    s4-build/       SKILL.md + guard + prompt
    s5-qa/          SKILL.md + guard + prompt
  knowledge/                   ← 톤·회사·기술·design-system (vendor, 얇게)
  runs/<project>/              ← 프로젝트별 계약파일 산출물 (영속)
```

- **poc-forge 스킬** = 순서 강제 · 컴포넌트 사이 게이트(사람 승인) · 가드(no-skip/커버리지/빌드그린/루프백) · manifest 관리. **도메인 지식 0.**
- **각 컴포넌트 스킬(S1~S5)** = 자기 역할 결과를 최대치로. **독립 실행 가능** (오케스트레이터 없이도 단독 호출됨).
- **연결 = 계약 파일**(대화 아님). 한 컴포넌트 OUT → 다음 컴포넌트 IN.
- **누적 맥락**: 각 컴포넌트는 *직전만이 아니라 이전 전부*의 계약을 보유하고 본다.
- **멀티 프로젝트**: `runs/<project>/`가 관리 단위 — 프로젝트마다 독립 폴더(`sources/` + 단계별 산출물 + manifest). 모든 스테이지 스킬은 **프로젝트명으로 호출**(`node <stage>/run.mjs <project>` → `runs/<project>/`; 이름=runs 하위, 경로 구분자 있으면 그 경로). 이전 프로젝트 보관·재개 가능. 목록/상태/이어하기 "관리"는 오케스트레이터(task #1, 나중).
- **누적·재도출**: `sources/`는 라운드로 **누적**(append-only) — 질문 답변·추가자료가 계속 쌓임. 스테이지 재실행 = 부분 패치가 아니라 **전체에서 처음부터 재도출**(스냅샷 덮어쓰기). S1은 나중 라운드가 앞 충돌/질문을 확정하면 `resolved`/`answered`로 반영해 재실행할수록 기획이 성숙(재플래그 안 함).

---

## 2. 5 컴포넌트 지도 (역할 · IN · 게이트 · OUT)

```
(S0 수집: 다양한 루트 → runs/<p>/sources/ 로 몰기 — *나중에 붙임*. 지금은 폴더가 이미 찼다고 가정)

S1 이해·정리 ─▶ S2 기획 ─▶ S3 설계 ─▶ S4 개발 ─▶ S5 QA
  [gate]         [gate]      [gate]      [gate]     [loopback→원인단계]
```

### S1 · 이해·정리 (understand) — ✅ 빌드+라이브검증 완료 (`skills/s1-understand/`)
- **역할 = 2가지**: ① 러프 데이터 **통일 정리·이해**(모순·빈틈은 지어내지 않고 표면화) ② 뒤 단계가 꺼내 쓸 **유용한 원자료를 자산으로 등재**(화면기획서→S3, 데이터 엑셀→S3/S4, RAG PDF→검색). 요약만 하고 원본 버리지 않음.
- **IN**: `runs/<p>/sources/` (S0 수집이 채워둠. 텍스트=본문 정독, pdf·엑셀·이미지=목록만 등재)
- **OUT**: `understanding.md`(사람용, context.json에서 결정적 렌더) + `context.json`(기계용)
- **gate**: "이해가 맞아요?"
- **내부**: intake(코드, truncate 없음) → 이해·정리(claude -p, lean 프롬프트) → guard(코드: 근거무결·**자산 커버리지 100%**·스키마). LLM 스왑 = `POC_FORGE_LLM_CMD`.

### S2 · 기획 (plan) — ✅ 빌드+라이브검증 완료 (`skills/s2-plan/`)
- **역할**: 정리된 이해로 **세부 기획.** 산출물 = ① 기능정의서 ② PRD. **"엑셀로 한 줄씩 관리할" 행-granularity**(버튼·상태·검증·상호작용 하나하나가 개별 행 — BigShift 실제 기능정의서 포맷 `구분/대분류/중분류/기능/상세내용/화면후보/참조데이터/제공범위/As-is/우선순위/상태/근거`). NFR·정책은 originate 아니라 extract.
- **IN**: `context.json` (+ `understanding.md`, `sources/` 원자료 전량 = 자세함 위해 digest+원본 둘 다)
- **OUT**: `spec.json`(기계, backbone) → `features.md`(기능정의서 표, 결정적 렌더) + `prd.md`(내러티브, claude 별도 서술 — suwon `project.md` 스타일)
- **gate**: "이 기획이면 돼요?"
- **내부**: claude 2콜(spec 스키마강제 → prd 프로즈) + 렌더. **가드(코드)**: 계층·상세내용 비면 fail(자세함 강제)·근거무결·confirmed는 근거+acceptanceHint(test 씨앗) 필수·커버리지·S1 오픈질문 승계. **"자세히"의 안전장치** = status(confirmed 소스근거 / proposed 도메인상식+가정명시 / open 미정). 라이브(gearloan): **기능 100행**(확정54/제안42/미정4)·NFR6·규칙12·오픈이슈9.

### S3 · 설계 (design) — ✅ 빌드+라이브검증 완료 (`skills/s3-design/`) · ★가장 무거움 · 내부 순차 + 화면 역산
- **역할**: UI/UX + 프론트 데모 화면 + DB + 서버 로직 + test 설계 + **개발 문서(자세히)**. 내부 순서가 중요:
  1. **UI/UX 설계** → IA/URL·페이지별 필드·상태·권한 (`page-spec.json`) + **gpt2 프론트 데모 화면** (`screens/*.png`)
  2. **[내부 gate: "이 화면이면 돼요?"]**
  3. **승인된 화면 + S2 기획서를 역산** → `schema.json`(DB) · `server-spec.json`(서버 로직/API) · `acceptance.json`(test 설계)
  4. **위 설계 전체를 바탕으로 개발 문서 자세히 작성** → `dev-doc.md` (구현 가이드: 구조·모듈·데이터흐름·구현 순서 — S4가 이걸 보고 개발)
  - test 설계가 S3에 있는 이유 = 기능 세부 testing이라 화면·데이터와 함께 잠가야 함.
- **IN**: `spec.json`·`features.md` (+ S1·S2 전부)
- **OUT**: `page-spec.json` + `screens/*.png` + `schema.json` + `server-spec.json` + `acceptance.json` + `dev-doc.md`
- **gate**: "이 설계면 돼요?" (화면 승인은 내부 gate로 이미 통과)

### S4 · 개발 (build)
- **역할**: **S1~S3의 맥락·결과를 전부 이해한 상태로** 설계대로 **실제 동작하는** Next.js 앱 개발. 개발 문서(dev-doc)+화면·목업·spec·schema·server 전체 맥락으로 구현, test는 **바닥(floor)**이지 구현의 전부 아님.
- **IN**: `dev-doc.md`·`page-spec.json`·`screens/*`·`schema.json`·`server-spec.json`·`acceptance.json` (+ S1~S3 전부)
- **OUT**: `app/`(Next.js App Router) + **빌드 그린**(`next build` exit 0)
- **gate(코드가드)**: **빌드 그린 없이 S5 진입 금지.**

### S5 · QA (qa)
- **역할**: **이중 판정** — ① test 통과(바닥) ② spec 전체 대비 누락(폭). teaching-to-test 방지.
- **IN**: `acceptance.json`·`spec.json`·`page-spec.json`·`app/` (+ 전부)
- **OUT**: `qa-result.md` + `qa-result.json`(pass/fail + gap + 근거 file:line)
- **loopback**: fail이면 원인 단계로 라우팅(요건→S2 / 화면·설계→S3 / 코드→S4), cap N회.

---

## 3. 계약 파일 스키마 (draft v0 — 각 스킬 만들 때 확정)

> 스키마는 "완벽 확정 후 구현"이 아니라 **해당 스킬을 만들면서 라이브로 확정**한다. 아래는 뼈대.

- **`runs/<p>/poc.manifest.json`** (오케스트레이터 소유): `{ project, stages[]{id,status:pending|running|done, contracts[], gate:approved?}, current_stage, loopbacks[] }`
- **`context.json`** (S1): `{ project, summary, facts[]{id,claim,topic,sources[]}, entities[], glossary[], contradictions[]{topic,positions[]{claim,source},note,status:open|resolved,resolution}, openQuestions[]{item,reason,sources[],status:open|answered,answer}, scopeSignals[]{item,phase,sources[]}, assets[]{file,kind,readable,useFor[],summary} }` — **assets[] = 뒤 단계 재사용 인덱스**(모든 소스 파일 100% 등재 강제) · **status/resolution/answer = 라운드 누적 시 해소 반영**.
- **`spec.json`** (S2): `{ project, product{name,goal,background,northStar,successCriteria[]}, personas[], scenarios[], scope{p1,p2,out,future}, features[]{id,구분,대분류,중분류,기능,상세내용,화면후보,참조데이터[],제공범위,asIs,priority,status(confirmed|proposed|open),sources[],acceptanceHint[],비고}, nfr[]{category,requirement,sources[]}, businessRules[]{id,rule,sources[],status}, openQuestions[], glossary[] }` — **행-granular 기능정의서**(BigShift 컬럼). `features.md`는 여기서 렌더, `prd.md`는 claude가 이걸 서술.
- **`page-spec.json`** (S3, phase ui): `{ ia[]{section,items[]{label,url,roles[]}}, pages[]{id, url, purpose, roles[], features[](spec 기능 매핑=커버리지), layout, components[], fields[]{name,why,validation}, states[], actions[]{label,effect,mutates}, media_refs[], renderScreen, gpt2Prompt}, flows[]{id,name,scenario,actor,steps[]{page,action,to}}(UX 여정) }`
- **`schema.json`** (S3): `{ tables[]{name, purpose, columns[]{name,type,nullable,note}}, relations[]{from,to,kind,note} }` (ORM 포터블; 화면 필드 + 비가시(상태머신·이력·부서·알림) 역산)
- **`server-spec.json`** (S3): `{ endpoints[]{id,method,path,purpose,roles[],in,out,logic,tables[],features[],rules[](BR 강제)}, dataFlow[] }` — 정책 커버리지: confirmed BR 전부 반영(hard)
- **`acceptance.json`** (S3): `{ selectors{의미:data-testid}(셀렉터 계약), tests[]{id,feature_id,page,type(normal|adversarial),setup,steps[],assert[](data-testid),rationale} }` — feature-level, 실행 가능, 바닥(confirmed 기능마다 ≥1 hard)
- **`qa-result.json`** (S5): `{ passed:bool, results[]{test_id, pass, evidence}, gaps[]{spec_ref, missing, file_line} }`
- **사람용 문서 계약**(prose, 기계본과 쌍): `understanding.md`(S1) · `prd.md`+`features.md`(S2) · `dev-doc.md`(S3, 구현 가이드).

---

## 4. 핵심 원칙 (값비싼 교훈 — 모든 스킬이 지킴)

1. **★ 전체 데이터 다 넣고, 하나도 빠짐없이 보고, 종합.** 입력 truncate 금지(Claude 200k+). 프롬프트에 미시규칙 우겨넣기 금지. **모델 신뢰.** → 프롬프트 = **역할 + 출력 스키마 + 필수 2~3개**(근거기반·지어내기 금지·유효 JSON)뿐. (옛 최대 실수 = "규칙 많이 + 데이터 조금". 옳은 건 "규칙 적게 + 데이터 전부".)
2. **extract not originate.** dealcatch 제안이 있으면 *추출/소비*, 중복 구현 X. 얇게 유지.
3. **test = 바닥이지 천장 아님.** 구현은 전체 맥락으로, test는 우회방지 최소선. QA는 이중(바닥 + 폭).
4. **완전 순차 + 화면 역산.** 각 단계는 직전 *승인된* 것만 기반. DB·서버·test는 spec이 아니라 **승인된 page-spec을 역산**.
5. **가드는 프롬프트가 아니라 코드로 강제.** no-skip · 커버리지(silent-drop 금지) · 근거(evidence) · **빌드 그린 없이 다음 금지** · 루프백. 우회 못하게를 코드로.
6. **얇게·단순·도메인 불가지.** 특정 도메인(작품/카탈로그 등) 프롬프트 하드코딩 금지. 컴포넌트 독립 실행.
7. **실제 동작 보증.** 정적 아님 — 빌드 그린 + AI QA. 최종엔 라이브 데모(배포).

---

## 5. 스킬 만드는 공통 레시피 (하나씩 이렇게 만든다)

> **★ 빌드 규율 (최상위): 연쇄로 몰아 만들지 말 것. 스킬 하나를 꼼꼼히 완성·라이브 검증하고 나서야 다음.** 옛 빌드가 한 엔진에 다 뭉쳐 무거워진 실수를 반복하지 않는다. 각 스킬은 자기 역할 결과가 *최상급*이 될 때까지 붙들고, 그 다음에 옆 스킬로.

각 컴포넌트 스킬 = 다음 4개로 구성, **test-first로** 만든다:

1. **SKILL.md** — Claude 진입점. 역할·IN/OUT 계약·언제 쓰는지. 얇게.
2. **prompt** — 역할 + 출력 JSON 스키마 + 필수 규칙 2~3개. (§4-1) 데이터는 *전부* 주입.
3. **guard (코드)** — 입력 계약 검증 + 출력 계약 검증(스키마·근거·커버리지). §4-5의 가드가 여기 산다.
4. **라이브 검증** — 임의 도메인 입력으로 **단독 실행** → 산출물이 도메인 적합·영속인지 눈으로 확인. 그 다음 앞 컴포넌트와 **연결** 테스트.

> 빌드 순서도 test-first: 계약(스키마) → guard(검증) → prompt → 라이브. 스킬 하나 초록 되기 전엔 다음 스킬 안 감.

---

## 6. 빌드 로드맵 (DO THIS — 하나씩, 꼼꼼히)

> 오케스트레이터를 *먼저 통째로* 만들지 않는다(연쇄 방지). 각 컴포넌트를 **독립 실행 스킬**로 꼼꼼히 완성하며 계약을 확정 → 계약이 굳으면 얇은 엔진이 자연히 따라온다.

- [ ] **0. 픽스처 심기**: `runs/gearloan/sources/` (사내 비품/장비 대여 — 카탈로그 아님, 모순·빈틈 일부 심어 S1 검증용).
- [ ] **1. S1 understand** 스킬 → gearloan 단독 라이브 검증(모순 표면화·오픈질문·근거). *여기서 `context.json` 계약 확정.*
- [ ] **2. S2 plan** 스킬 → S1 연결 검증. *`spec.json`+`features.md` 계약 확정.*
- [x] **3. S3 design** 스킬 (UI/UX 화면+flows → 내부게이트 → 역산 DB/서버/test → 개발문서) → gearloan 라이브 검증. 2페이즈(`--phase=ui|design`)+`--no-images`/`--images-only`. 정책(BR) 커버리지 hard가드로 화면-first가 비가시 명세 안 떨구게. *page-spec에 `flows[]`(UX 여정)·`schema`에 상태머신/이력/부서/알림 역산 확정.*
- [ ] **4. S4 build** 스킬 → 빌드 그린 게이트 라이브.
- [ ] **5. S5 qa** 스킬 → 이중판정 + 루프백 라이브.
- [ ] **6. 오케스트레이터 수렴**: 컴포넌트 계약이 다 굳으면 `poc.manifest.json` + 얇은 엔진(.mjs)이 순서·게이트·가드·루프백을 코드로 강제하게 엮음. (앞에서 각 스킬이 이미 계약 준수하므로 얇게 끝남.)
- [ ] **7. 코어 완성 후**: docsmaster 문서 위임 · 배포/라이브 데모(dealcatch proposal-site 참고) · 자율 monitor.

---

## 7. 기술 스택·환경 (결정된 것)

- 앱 = **Next.js (App Router)** · DB = **SQLite**(로컬) → 배포 시 Supabase. ORM 포터블(Drizzle/Prisma).
- LLM = **`claude -p` 헤드리스**(텍스트 API 키 없음). 얇은 엔진/스킬이 단계별 스폰(스왑 가능 어댑터).
- gpt2 = fal `openai/gpt-image-2`, `bigshift/.env`의 `FAL_KEY`. 데스크톱 화면은 `landscape_16_9`.
- 도구경로: CHROME=`C:/Program Files/Google/Chrome/Application/chrome.exe` · Poppler(pdfinfo/pdftotext)=WinGet `oschwartz10612.Poppler`.
- 플랫폼 win32 / Git Bash + PowerShell. `gh` 없음. `wonderfulskills` 폴더 자체는 git repo 아님.

---

## 8. 결정 잠금 (2026-07-01)

- [x] 컴포넌트 스킬 위치 = **`poc-forge/skills/`** 하위 (오케스트레이터가 관장하기 좋게).
- [x] 오케스트레이터 = **얇은 코드 엔진(.mjs)** — manifest·순서·가드·루프백을 코드로(가드=코드 원칙 충실, 옛 엔진 *얇게* 재사용). `SKILL.md`는 진입점.
- [x] 라이브 검증 픽스처 도메인 = **사내 비품/장비 대여 관리** (재고·대여상태·반납기한·승인 플로 — 카탈로그 아님, lokmedia 잔재 회피). 프로젝트 id = `gearloan`(가칭).
- [x] 컴포넌트 스킬 네이밍 = **`s1-understand` / `s2-plan` / `s3-design` / `s4-build` / `s5-qa`**.

---

## 10. 버전 관리 (이력 = Git · 신선도 = manifest)

파이프라인이라 버전관리는 **2축**이고, 서로 보완한다:
- **이력(무엇이 어떻게 바뀌었나) = Git.** poc-forge가 git repo(`.gitignore`·`.gitattributes` 포함). 각 스테이지 `run`이 **best-effort 자동 커밋**(`lib/version.mjs` `commitRun`, 메시지 `[<project>] <stage> · 요약`). 라운드 간 diff·롤백·비교 공짜. 커밋 실패(비repo/변경없음)는 비치명 skip. 모든 프로젝트가 한 저장소.
- **신선도(지금 뭐가 신선/낡음) = manifest (오케스트레이터, 나중).** 각 산출물에 `_meta{stage,generatedAt,inputCount,inputsFingerprint}` 도장(`stampMeta`) — 상류 소스/계약이 바뀌면 지문이 바뀐다. 오케가 이 지문으로 하류를 `stale` 표시 + 재실행 유도(= 루프백의 **정방향**). **★핵심 위험**: S1 재실행으로 이해가 바뀌면 그 *옛 버전*으로 만든 S2~S5는 낡음 → 반드시 아래로 다시 흘려보내야 함. 이걸 시스템이 알아야 한다.
- **재도출 모델**: 스테이지는 매번 상류 전체에서 재도출(스냅샷 덮어쓰기) + 커밋. `sources/`는 append-only 누적.

## 9. 재사용 참고 (복사 아니라 학습 — 위치)

- **old-poc-pilot** `../old-poc-pilot/`: 좋은 참고 = 엔진 구조(`engine/engine.mjs`)·계약파일 체인·코드강제 가드·docsmaster 어댑터(`engine/docsmaster-claude.mjs`). 반면교사 = 프롬프트 과잉·입력 truncate·lokmedia 하드코딩·한 엔진에 다 뭉침. 픽스처 `runs/flowstudio`·`runs/lokmedia-b`.
- **dealcatch** 최신 = GitHub `bigshift-projects/dealcatch-v2`(blobless clone). 볼 것: `.codex/rfp-writer·proposal-*`(기획), `scripts/generate-ux-suggestions.mjs`(gpt2 UX), `.codex/design-system`(heroui/toss), `proposal-site`(배포/데모), `platform-monitor`(자율), `.codex/SKILL.md`(마스터 플로우).
- **docsmaster** = `../../docsmaster/`(로컬, 빌드됨). 문서엔진(요구·화면·DB·아키·테스트 8종 + PDF). poc-forge와 동일 어댑터 패턴(`DOCSMASTER_LLM_COMMAND`). 납품문서 필요 시 위임. (Windows 버그 3개 이미 수정됨.)
