# S5 · QA — 설계 + 구현 상태

작성 2026-07-02 · 상태: **구현 완료(코드·SKILL·결정적코어 검증) · 라이브 미실행(S4 앱 대기)**. poc-forge DESIGN.md §2-S5 준수.

> **구현됨(2026-07-02)**: `guard.mjs`(buildTestPlan=UI61·API29·셀렉터68·폭54/12·적대타깃9 실검증 / validateInputs·validateQaResult·**validateCoverage**(silent-drop 하드) / routeLoopback(최상류 라우팅+breakdown) / **isBlockingGap** / **resolveDateToken**(+16d→절대날짜)) · `run.mjs`(prep=DB wipe·clean build 재시도·**detached 서버+unref**·**네이티브 fetch 준비폴링**·상대날짜해석 대본 / finalize=스키마·**커버리지 교차검증**·판정·리치 렌더·**spawnSync taskkill 트리종료**·commit / 엔트리가드로 import 부작용 0) · `SKILL.md`(Discover→UI(네이티브 상호작용+evaluate_script assert)→API(fetch checks)→적대→폭→raw 스키마, 로그인=evaluate_script fetch, 접근거부=200+forbidden). 결정적 코어 전부 단위검증 통과.
> **미완(라이브)**: `runs/gearloan/app/`이 반빌드(스캐폴드 4개 lib만) → prep의 build/서버·MCP 구동을 아직 못 돌림. **S4 full 빌드 그린 확보 후** prep→MCP→finalize 라이브 검증 필요(호스트 `node skills/s4-build/run.mjs gearloan` 또는 서브에이전트 병렬).

---

## 0. 역할 (변하지 말 것)
S4가 만든 *돌아가는* 앱을 **다차원 판정**한다(단순 UI 스냅샷 아니라 API·규칙·적대까지 전반):
- **① UI 바닥(floor)**: `acceptance.json` 테스트 전부를 실브라우저(chrome-devtools MCP)로 실행 → pass/fail + 근거.
- **② API**: `server-spec.json` 엔드포인트 전부를 직접 호출(fetch) → 상태코드·응답형태·**접근제어(미허용 롤 4xx)**·**규칙강제(BR 위반 4xx)** 검증. (UI가 안 드러내는 서버 계약을 직접 친다.)
- **③ 적대(adversarial)**: qa-pilot Jinx 플레이북 차용 — 입력/상호작용/내비/상태 공격으로 우회·중복·검증깨짐 탐색(acceptance 적대를 넘어). 실익스플로잇 금지, 의심보안은 기록만.
- **④ 폭(breadth)**: `spec.json`의 confirmed 기능·businessRule 전체를 앱 동작과 대조 → 위 셋이 놓친 gap.
teaching-to-test 방지. fail이면 **원인 단계로 루프백**(요건→S2 / 화면·설계→S3 / 코드→S4), cap N=2~3회.

## 1. ★ 아키텍처 — S1~S4와 다르다 (핵심)
S1~S4는 `run.mjs`가 `claude -p`를 spawn하는 **node 주도**. S5의 러너는 **chrome-devtools MCP**(=Claude Code가 직접 호출하는 `mcp__chrome-devtools__*` 툴, node가 spawn 못 함). 따라서 실행을 3분할:

```
① run.mjs prep <project>   (결정적·node)   — DB wipe → clean build → next start(:PORT) → .s5-plan.json(계약 대본) 산출 → PORT/로그인레시피 출력
② Claude가 chrome-devtools MCP로 구동 (SKILL.md 지시):
     A. Discover — app/ 소스 + 실제 렌더 UI 크롤(코드베이스+UI 분석)로 "무엇을 QA할지" 발견(계약 밖/drift 포함)
     B. Execute  — 계약 대본(UI+API) + 발견분 + 적대 실행, 근거 수집
     C. Breadth  — spec 기능·BR 대비 미접촉분 대조 → qa-result.raw.json
③ run.mjs finalize <project> (결정적·node) — raw 검증(guard)→pass/fail+루프백 판정→qa-result.json/.md 렌더→서버 종료→커밋
```
- **가드=코드, 판단=Claude** 원칙 유지: 준비·검증·루프백 라우팅·렌더는 node(guard), 발견·구동·관찰·판정은 Claude(MCP).
- ★ **계약 우선 + 발견 보강**(핵심 균형): `.s5-plan.json`(=S3 acceptance/server-spec에서 결정적 도출)이 **바닥(반드시 통과)**. 거기에 **Discover(코드베이스+UI 분석)로 계약에 없던/어긋난 것을 추가 발굴** = qa-pilot 방식. "계약만 맹목 실행"도 "계약 무시 프리스타일"도 아니다. 발견이 계약과 다르면 = **drift**(gap/loopback).

## 2. IN / OUT
- **IN**: `acceptance.json`(64테스트+셀렉터·**setup.role**) · `spec.json`(폭 대조용 features/BR) · `page-spec.json`(롤·플로우) · `runs/<p>/app/`(빌드 그린) + S1~S4 전부.
- **OUT**: `qa-result.json`(기계) + `qa-result.md`(사람). loopback 필드로 원인 단계 라우팅.

## 3. qa-result.json 계약 (draft)
```json
{
  "project": "gearloan",
  "passed": false,
  "summary": { "total": 64, "passed": 60, "failed": 4, "floorPass": false, "breadthGaps": 3 },
  "results": [
    { "test_id": "T-025-2", "feature_id": "F-025", "type": "adversarial", "role": "직원",
      "pass": false, "evidence": "snapshot: error-period 미표시 · POST /api/loans 200(거부 안 됨)",
      "failReason": "2주 상한(BR-1)이 서버에서 안 막힘", "cause": "S4" }
  ],
  "gaps": [
    { "kind": "rule", "ref": "BR-8", "missing": "외부 도메인 로그인 거부 경로 미확인", "evidence": "…" },
    { "kind": "feature", "ref": "F-060", "missing": "지연 배치 알림이 대시보드에 안 뜸", "evidence": "…" }
  ],
  "loopback": { "stage": "S4", "reason": "정책(BR-1) 서버 미강제 — lib/policy·loans 재생성" },
  "_meta": {}
}
```

## 4. acceptance → chrome-devtools MCP 매핑 (러너 대본)
| acceptance | MCP 툴 |
|---|---|
| setup.role + setup.route | 로그인(§5) → `mcp__chrome-devtools__navigate_page(route)` |
| step.navigate | `navigate_page(target)` |
| step.click | `click(uid)` (셀렉터→uid는 `take_snapshot`으로 해석) |
| step.fill | `fill(uid, value)` |
| step.select | `fill`/`select` |
| step.wait | `wait_for(text)` |
| assert.visible/absent | `take_snapshot` → data-testid 존재/부재 |
| assert.count | 스냅샷 내 매칭 개수 |
| assert.text | 요소 텍스트 |
| assert.url | 현재 URL |
| assert.attr | 속성값 |
- 셀렉터는 `[data-testid=X]` (S4가 부여, S3 selector 계약 hard). 값 `+15d` 같은 상대표기는 prep이 해석해 대본에 절대값으로 넣거나 Claude가 해석.
- **wait 규율·셀렉터 우선순위**(data-testid 우선)는 `qa-pilot/references/browser-mcp-guide.md` 차용.

## 5. 로그인 레시피 (이 세션 검증됨)
- mock SSO: `POST /api/auth/sso/callback`, body `{"googleIdToken":"<role>"}` (role = setup.role 값: 직원/팀장/총무/…, 또는 미인증이면 로그인 스킵).
- ★ **한국어 UTF-8**: 브라우저 fetch(`evaluate_script`)는 안전. (이 세션에서 Git Bash inline curl은 한글 깨짐 확인 → 러너는 브라우저/파일바디만. MCP fetch면 문제없음.)
- 반환: 세션쿠키 `gearloan_session` + `{userId,name,role,landing}`. 롤별 랜딩 분기.
- 도메인 불가지: 롤 문자열·엔드포인트 경로는 계약(acceptance.setup.role · server-spec auth 엔드포인트)에서. gearloan 고정 금지.

## 6. 접근제어 판정 (이 세션 검증됨)
- **페이지** 권한 없음 = HTTP **200 + AccessDenied 컴포넌트**(`data-testid=access-denied`), 본문 미렌더. (403 아님!) → 적대 페이지 테스트는 `visible access-denied` + `absent 본문테이블`로 판정.
- **API** 권한 위반 = 4xx JSON. → API 적대는 상태코드로.

## 7. 실행 전제 (prep이 보장)
1. **DB wipe**: `runs/<p>/app/data/*.db` 삭제 → 오늘 기준 재시드(S4 seed가 SEED_NOW 상대앵커라 날짜 드리프트 방지). (S4 db.ts에 이전날짜 자동삭제도 있으나 prep이 확실히.)
2. **clean build**: `rm -rf .next && next build`(Windows stale-.next rename flake 회피; 실패 시 S4의 `isTransientFsError` 재시도 패턴 재사용). 대안: `next dev`(빌드 없이 — behavior QA엔 충분·더 견고, 폴백).
3. **server**: `next start -p PORT`(또는 dev) 백그라운드 → ready 폴링.

## 8. 판정 상세

### 8.A Discover (코드베이스 + UI 분석) — 무엇을 QA할지 발견 (qa-pilot Discovery 차용)
계약 대본을 실행하기 *전에*, 실제 앱을 분석해 QA 대상을 넓힌다(계약 밖·drift 포착):
- **코드베이스**: `app/**/route.ts`(실제 엔드포인트·핸들러) · `app/**/page.tsx`(실제 화면·서버/클라 분리) · `lib/*.ts`(도메인 로직·auth 가드·정책) · `components/ui.tsx`(실제 data-testid) — 계약(server-spec/page-spec)과 대조해 **불일치(drift)** 를 찾는다(예: 계약엔 있는데 route 없음, 화면에 계약 밖 액션).
- **실 UI 크롤**: 각 라우트를 MCP로 navigate → `take_snapshot`으로 **실제 렌더된 요소·상호작용·상태**를 인벤토리화(qa-pilot PAGE-INVENTORY). 계약 셀렉터가 실제 존재하는지, 미명세 상호작용이 있는지.
- 산출: 계약 대본(uiTests/apiTests)에 **발견분(discovered)** 을 추가. 계약과 어긋나면 drift로 표시(→ gap/loopback). *단 계약이 바닥 — 발견은 보강이지 대체 아님(extract-not-originate 유지).*

### 8.B 다차원 판정 (`.s5-plan.json`의 블록 = guard.buildTestPlan 산출 + 발견분)
- **① UI(uiTests)**: acceptance 테스트 전부 브라우저 실행. 각 fail은 **실행 근거(스냅샷/DOM/네트워크/콘솔) 필수**. confirmed 기능 바닥커버는 S3 hard 보장.
- **② API(apiTests)**: server-spec 각 엔드포인트를 `evaluate_script` fetch로 직접 호출. 각 엔드포인트 checks:
  - `normal` → 허용 롤·정상입력 → 2xx + 응답이 `out` 형태.
  - `access`(roles 있으면) → 미허용 롤/미인증 → 401/403.
  - `rule`(rules 있으면) → 규칙 위반 입력(logic에서 위반상황 구성, 예 대여 15일=BR-1) → 4xx.
  - `input`(WRITE) → 빈/무효/경계 입력 → 4xx.
  네트워크 관찰은 `list_network_requests`, 콘솔 에러는 `list_console_messages`.
- **③ 적대(adversarial)**: `adversarial.targets`(입력/변경 화면)에 `adversarial.categories`(Input/Interaction/Navigation/State) 적용. 참조 `qa-pilot/references/adversarial-playbook.md`(공격 목록·심각도 루브릭·리포트 블록 그대로 차용). 발견은 심각도와 함께 fail/gap로, **실익스플로잇 금지**·의심보안은 사람 후속.
- **④ 폭(breadth)**: confirmed 기능·BR 중 ①②③이 직접 안 건드린 것을 spot-check(예 배치 알림·집계 정확성). gap은 `gaps[]`로.
- 통합: `qa-result.raw.json`에 results[](①②③) + gaps[](④) + 각 항목 cause(S2/S3/S4)를 Claude가 기록 → finalize가 판정·라우팅.

## 9. 루프백 라우팅 (guard가 결정)
- 셀렉터 미부여·로직 오류·4xx 미반환·상태전이 안 됨 → **S4**(코드).
- 화면/필드/플로우 설계 누락·엔드포인트 없음 → **S3**(설계).
- 요건 자체 모호/미명세(기능이 spec에 없음) → **S2**(기획).
- 폭 gap: 대개 S3(설계 누락) 또는 S2(기획 누락).
- 한 라운드에 여러 원인이면 **가장 상류**로(S2>S3>S4) 라우팅 후 순방향 재흐름. cap 초과 시 사람 개입 요청.

## 10. 빌드 방식 (S1~S4처럼 test-first)
계약(qa-result 스키마)→guard(입력·결과 검증·루프백)→SKILL.md(MCP 구동 지시)→prep/finalize(node)→gearloan 라이브. lib/version(commit·stale)·lib/clean 재사용.

## 11. 참조 (복사 아니라 학습)
- `wonderfulskills/qa-pilot/`(빌드됨): 코드인지 시나리오→브라우저 MCP 검증(Quinn)+적대 파괴(Jinx)→durable 테스트. `references/{browser-mcp-guide,adversarial-playbook,scenario-format}.md`. **차이**: S5는 시나리오를 acceptance.json에서 *소비*, spec 대비 폭 판정 추가.
- chrome-devtools MCP 툴: navigate_page/click/fill/take_snapshot/wait_for/evaluate_script/list_network_requests/list_console_messages/take_screenshot.
- 이 저장소 S4 런타임 스모크(이 세션): 서버부팅·롤로그인·바인딩·접근제어 실동작 확인됨(핸드오프 §5-S4).

## 12. 체크리스트
- [x] `.s5-plan.json` 스키마 확정 + prep이 acceptance/server-spec/spec에서 결정적 생성(role·steps·asserts·selectors·상대날짜해석 펼침).
- [x] guard: 입력 계약(acceptance·app 존재) + qa-result 스키마 + **커버리지(silent-drop 하드)** + 루프백 라우팅 함수 + isBlockingGap + resolveDateToken. (단위검증 통과)
- [x] SKILL.md: Claude가 MCP로 plan 실행하는 절차(Discover→로그인 fetch→steps(네이티브)→assert(evaluate_script)→API fetch→적대→폭→근거수집·raw 스키마).
- [x] run.mjs: prep(wipe·build·detached start·plan) / finalize(검증·커버리지·판정·렌더·트리종료·commit). 서버 라이프사이클 + 엔트리가드.
- [ ] **gearloan 라이브**: 먼저 S4 full 빌드 그린 확보 → S5 prep → MCP 구동 → 다차원판정 → (일부러 fail 심어) 루프백 검증. ← **다음 (S4 앱 대기)**
- [ ] 오케스트레이터 수렴(task#6, 나중)에서 S5 loopback을 manifest와 엮음.
