---
name: s5-qa
description: poc-forge 파이프라인의 S5(QA) — S4가 만든 돌아가는 Next.js 앱을 실브라우저(chrome-devtools MCP)로 QA한다. **계약 우선 + 발견 보강**: S3 acceptance/server-spec의 테스트를 전부 실행(바닥)하고, 추가로 코드베이스(app/·lib/)+실 UI를 분석해 QA 대상을 발견(drift·미테스트). 다차원 = ①UI ②API(엔드포인트 상태·접근제어·규칙강제) ③적대(qa-pilot) ④폭(spec 대비). fail이면 원인 단계(S2/S3/S4)로 루프백. 준비·검증·라우팅은 node(run.mjs·guard.mjs), 발견·구동·판정은 Claude(MCP). 단독 실행 가능한 컴포넌트 스킬. "S5 QA 돌려", "gearloan QA", "앱 검수" 시 사용.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - mcp__chrome-devtools__navigate_page
  - mcp__chrome-devtools__take_snapshot
  - mcp__chrome-devtools__click
  - mcp__chrome-devtools__fill
  - mcp__chrome-devtools__evaluate_script
  - mcp__chrome-devtools__wait_for
  - mcp__chrome-devtools__list_network_requests
  - mcp__chrome-devtools__list_console_messages
  - mcp__chrome-devtools__take_screenshot
  - mcp__chrome-devtools__new_page
  - mcp__chrome-devtools__list_pages
---

# S5 · QA (qa) — 실브라우저 이중판정 런북

poc-forge 5컴포넌트의 마지막. S4의 *돌아가는* 앱을 **실브라우저로 다차원 판정**한다. **목업 검수 아니라 실동작 검수.**

> ★ 배경은 `skills/s5-qa/DESIGN.md`. 이 문서는 **실행 절차**다. 계약파일은 전부 `runs/<project>/`에 있다.

## 입출력
- **IN**: `runs/<project>/` 의 `acceptance.json`·`spec.json`·`page-spec.json`·`server-spec.json`·`app/`(빌드 그린) + S1~S4 전부.
- **OUT**: `runs/<project>/qa-result.raw.json`(당신이 MCP로 작성) → finalize가 `qa-result.json` + `qa-result.md`로 판정·렌더.

## 아키텍처 = 3분할 (node → Claude → node)
```
1) node skills/s5-qa/run.mjs prep <project>     ← 결정적: DB wipe·(clean build)·서버기동·.s5-plan.json
2) [당신이 chrome-devtools MCP로 구동]           ← 이 문서. Discover→Execute→Breadth→qa-result.raw.json
3) node skills/s5-qa/run.mjs finalize <project>  ← 결정적: 검증·커버리지·판정·루프백·렌더·서버종료·commit
```
**가드=코드, 판단=Claude.** 당신은 실제 브라우저를 몰아 관찰·판정하고 **근거와 함께** raw를 쓴다. node는 우회 못하게 검증·라우팅한다.

---

# STEP 1 — prep 실행 (당신이 Bash로)
```bash
node skills/s5-qa/run.mjs prep <project>          # 빌드 그린 증명 + start
node skills/s5-qa/run.mjs prep <project> --dev    # 빌드 flake 회피(behavior QA엔 충분·더 견고)
node skills/s5-qa/run.mjs prep <project> --port=3400
```
prep이 출력하는 것: **baseUrl**(예 `http://localhost:3210`) · 대본 카운트(UI/API/폭) · **로그인 레시피** · 접근거부 판정 셀렉터. 그리고 `runs/<project>/.s5-plan.json`(대본)을 남긴다.

빌드 실패로 prep이 멈추면 → 먼저 `--dev`로 재시도. 그래도 서버가 안 뜨면 그건 **S4 결함**(loopback→S4) 이니 그렇게 기록.

# STEP 2 — MCP 구동 (핵심)

## 2.0 대본 로드
`runs/<project>/.s5-plan.json` 을 Read 한다. 필드:
- `baseUrl` · `login{method,path,body,roleValues}` · `accessDenySelector`
- `uiTests[]{id,feature_id,type,role,route,steps[],asserts[],rationale}` — **상대날짜는 이미 절대값으로 해석됨**(그대로 입력).
- `apiTests[]{id,method,path,roles,in,out,logic,rules,checks[]}` — 엔드포인트 직접 검증 대본.
- `adversarial{categories,targets}` · `breadth{features,rules}` · `selectors{의미:셀렉터}`.

**대본이 바닥이다. 전부 실행한다(silent-drop 금지 — finalize가 UI 커버리지를 하드 체크).** 발견분은 *추가*(대체 아님).

## 2.1 Discover — 무엇을 QA할지 발견 (계약 밖·drift 포착)
계약 실행 *전에* 실제 앱을 분석:
- **코드베이스** (Read/Grep): `app/**/route.ts`(실제 엔드포인트·핸들러) · `app/**/page.tsx`(실제 화면·서버/클라 분리) · `lib/*.ts`(도메인 로직·auth 가드·정책) · `components/*`(실제 data-testid). server-spec/page-spec과 대조해 **drift**를 찾는다(계약엔 있는데 route 없음 / 화면에 계약 밖 액션 / 셀렉터 미부여).
  - **★ 로그인 경로 확인**: 실제 auth route handler를 찾아 로그인 방식·세션 쿠키명·롤 주입법을 확정. `.s5-plan.json`의 `login.path`는 계약값(server-spec) — 실제 앱이 다른 경로(예 `/api/auth/sso/callback`)로 동작하면 **실경로를 쓴다**(이건 예상된 유연성이지 drift 아님; 로그인 자체가 롤별로 안 되면 그때 S4 결함).
- **실 UI 크롤**: 주요 라우트를 `navigate_page`→`take_snapshot`으로 훑어 실제 요소·상호작용을 인벤토리화. 계약 셀렉터가 실존하는지, 미명세 상호작용이 있는지.
- 발견분은 실행 목록에 추가하고, 계약과 어긋나면 drift로 표시(→ gap 또는 fail의 cause).

## 2.2 로그인 헬퍼 (evaluate_script fetch — 한글 UTF-8 안전)
쿠키는 **브라우저가 자동 관리**한다. 순서: (a) 앱 오리진으로 먼저 navigate(쿠키 스코프 확보) → (b) fetch로 로그인 → (c) 대상 route로 navigate.

```js
// role 로그인. 성공 시 Set-Cookie가 브라우저 쿠키자에 자동 반영됨.
// navigate_page({type:"url", url: baseUrl + "/login"}) 를 먼저 호출한 상태에서:
async () => {
  const res = await fetch("/api/auth/login", {            // ← Discover에서 확정한 실제 경로
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ googleIdToken: "직원" }),        // ← test.role (직원|팀장|총무)
  });
  return { status: res.status, body: await res.text() };
}
```
- `role === "미인증"` 이면 로그인 스킵(로그아웃 상태). 필요 시 이전 세션 정리: 로그아웃 엔드포인트 fetch 또는 `new_page`로 새 컨텍스트.
- **롤 전환**: 다음 role로 로그인 fetch를 다시 하면 세션이 교체된다(같은 페이지 컨텍스트). 롤 경계 오염이 걱정되면 role 그룹별로 테스트를 묶어 실행.

## 2.3 ① UI 테스트 실행
각 `uiTests[]` 마다:
1. **로그인**: `role` 로 2.2 (미인증이면 스킵).
2. **navigate**: `navigate_page({type:"url", url: baseUrl + route})`. 이후 `wait_for({text:[...]})` 로 핵심 텍스트가 뜰 때까지 대기(하이드레이션). 셀렉터 대기는 wait_for가 텍스트 기반이므로, 안 잡히면 아래 폴링 스니펫 사용.
3. **steps 실행** (순서대로):
   - `navigate` → navigate_page.
   - `click`/`fill`/`select` → **네이티브 툴 사용**(React 이벤트 안전): `take_snapshot`으로 target 셀렉터에 해당하는 요소의 `uid`를 찾아 `click({uid})` / `fill({uid, value})`. `select`도 `fill({uid, value})`(옵션 선택 지원).
     - snapshot에서 uid를 못 찾으면: 그 요소가 **없는 것**(assert 대상이면 fail 근거). data-testid로 매칭할 땐 snapshot의 라벨/역할과 대조하되, 애매하면 evaluate_script로 존재를 먼저 확인.
   - `wait` → `wait_for({text})`.
4. **asserts 판정** — **evaluate_script의 querySelector로** (data-* 복합셀렉터·count·attr·absent에 견고):
   | assert.kind | evaluate_script 판정 |
   |---|---|
   | `visible` | `!!el && el.offsetParent !== null` (el = querySelector(target)) |
   | `absent` | `document.querySelectorAll(target).length === 0` |
   | `count` (op `>=`/`==`) | `document.querySelectorAll(target).length` 을 op·value와 비교 |
   | `text` (op `contains`) | 매칭 요소들의 textContent가 value 포함 |
   | `attr` | value가 `data-x=Y` 면 `el.getAttribute('data-x') === 'Y'`; `disabled=true/false`면 `el.disabled`; `data-theme=..`는 셸 요소의 속성 |
   | `url` | `location.pathname === value` (해시/쿼리 제외 비교) |

```js
// 범용 assert 판정 스니펫(예: count/visible/attr 한 번에 관찰용)
(sel) => {
  const els = [...document.querySelectorAll(sel)];
  return {
    count: els.length,
    firstVisible: els[0] ? els[0].offsetParent !== null : false,
    firstText: els[0]?.textContent?.trim().slice(0, 120) || null,
    url: location.pathname,
  };
}
```
- **셀렉터 표기**: 계약은 `[data-testid=login-card]`, 복합은 `[data-testid=equipment-card][data-status=가용]`. querySelector에 그대로 넣는다(한글 속성값 OK).
- **접근거부 판정(중요)**: 페이지 권한 없음 = **HTTP 200 + `accessDenySelector` 렌더**(403 아님). 적대 페이지 테스트는 `visible <accessDenySelector>` + `absent <본문 셀렉터>` 로 판정(예 T-005-1). 4xx를 기대하지 말 것 — 그건 API 얘기.
- 각 테스트: 모든 assert 통과 → `pass:true`. 하나라도 실패 → `pass:false` + **근거**(어떤 assert가 왜 틀렸는지: 관찰된 count/attr/url + 필요 시 `take_screenshot` 파일경로 + 관련 `list_console_messages` 에러).

## 2.4 ② API 테스트 실행 (server-spec 직접 타격)
각 `apiTests[]`의 `checks[]` 마다 `evaluate_script` fetch로 직접 호출. **UI가 안 드러내는 서버 계약을 친다.**
```js
async () => {
  const r = await fetch("/api/loans", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ /* check에 맞는 payload */ }),
  });
  let body; try { body = await r.json(); } catch { body = await r.text(); }
  return { status: r.status, body };
}
```
- `normal`: 허용 롤로 로그인 후 정상 입력 → **2xx** + 응답이 `out` 형태인지. (WRITE는 실제로 상태를 바꾸므로, 순서상 정상 케이스는 신중히 — 필요하면 뒤에.)
- `access` (roles 있으면): **미허용 롤/미인증**으로 호출 → **401/403**. 통과 못하면(2xx) = 접근제어 구멍(fail, cause S4). 예: 직원이 `PATCH /api/loans/[id]/confirm`(총무 전용) → 4xx여야.
- `rule` (rules 있으면): `logic`을 읽고 **위반 상황을 구성**한 입력 → **4xx**. 예 `POST /api/loans` 기간 15일(BR-1 2주 상한) → 거부. 3건 보유자 4번째(BR-2) → 거부. 규칙이 서버에서 안 막히면 fail(cause S4, teaching-to-test 위험 지점).
- `input` (WRITE): 빈/무효/경계 입력 → **4xx**(목적 빈값·잘못된 enum 등).
- 관찰: `list_network_requests`(상태·타이밍) · `list_console_messages`(서버/클라 에러). 각 API 결과 test_id = `apiTests[].id`(예 `API-EP-loan-create`), 각 check는 그 결과의 근거/서브판정으로.
- **경로 파라미터** `[id]`: 실제 시드/생성된 loanId·equipmentId로 치환(Discover에서 확보하거나 목록 API로 조회).

## 2.5 ③ 적대 (qa-pilot Jinx)
`adversarial.targets`(입력/변경 화면)에 `adversarial.categories` 적용. 참조: `wonderfulskills/qa-pilot/references/adversarial-playbook.md`(공격 목록·심각도 루브릭). acceptance 적대를 **넘어서는** 탐색.
- Input(1000자·유니코드·`<script>alert(1)</script>`·`'; DROP TABLE`·`{{7*7}}`·빈값·극단날짜) / Interaction(제출 5연타→중복레코드·더블클릭) / Navigation(미인증 딥링크·URL param 변조·마법사 중간 새로고침) / State(빈 제출·필수 사전단계 건너뜀·모달 2회).
- **★실익스플로잇 금지.** 페이로드가 실제로 렌더/실행되거나 auth 우회가 되면 = **의심보안**으로 `notes[]`에 기록만(에스컬레이트 X). UI/UX 파손(중복제출·검증깨짐·크래시)은 fail/gap로 심각도와 함께.

## 2.6 ④ 폭 (breadth) — teaching-to-test 방지
`breadth.features`(confirmed 기능)·`breadth.rules`(BR) 중 ①②③이 **직접 안 건드린 것**을 spot-check. 예: 부서별 집계 정확성·배치 알림·이력 자동기록·집계 KPI. 앱 실동작과 대조해 **누락/불일치**를 `gaps[]`로(근거·cause와 함께). 확인 불가(예 seed가 상황을 못 만듦)면 `notes[]`(비차단).

## 2.7 결과 기록 — 그룹마다 append (한 방에 거대 JSON 쓰지 말 것)
**★ 크래시 안전·거대write 회피**: 한 그룹(예: 직원 UI 묶음 / API 묶음 / 적대 / 폭)을 끝낼 때마다 그 결과들을 **`runs/<project>/qa-result.raw.jsonl` 에 append**(파일 끝에 이어쓰기, 덮어쓰기 금지). **한 줄 = 객체 1건**, 각 줄에 `_t`("result"|"gap"|"note")를 붙인다. finalize가 이 jsonl을 조립(결과는 test_id로 dedup=마지막 우선). 61+29+…를 마지막에 한 번에 만들지 말 것 — 중간에 죽어도 이미 쓴 그룹은 보존된다.
```
{"_t":"result","test_id":"T-093-1","feature_id":"F-093","type":"normal","role":"미인증","pass":true,"evidence":"login-card=1, sso-login-btn=1 visible"}
{"_t":"result","test_id":"API-EP-loan-create","type":"normal","role":"직원","pass":false,"evidence":"rule(dueDate+16d):200 loanId 생성됨(BR-1 서버 미강제)","failReason":"2주 상한 미강제","cause":"S4"}
{"_t":"gap","kind":"feature","ref":"F-072","missing":"부서별 집계 합계 불일치","evidence":"관찰 3 vs 실제 5","cause":"S3","severity":"high"}
{"_t":"note","title":"의심보안","detail":"검색 <script> 미이스케이프","evidence":"screenshots/031-xss.png"}
```
(파일 append는 Bash `>>` 또는 Read-후-Write로. 대안: 끝에 `qa-result.raw.json` 한 방 쓰기도 finalize가 지원하지만 **jsonl append가 기본·권장**.)

스키마(각 줄): **모든 fail은 실행 근거 필수**(근거 없으면 finalize가 거부).
```json
{
  "project": "<project>",
  "results": [
    { "test_id": "T-025-1", "feature_id": "F-025", "type": "adversarial", "role": "직원",
      "pass": true, "evidence": "snapshot: error-period visible=true (기간 16일 거부 확인)" },
    { "test_id": "T-025-1-server", "feature_id": "F-025", "type": "adversarial", "role": "직원",
      "pass": false, "evidence": "POST /api/loans (dueDate +16d) → 200 loanId 생성됨. error-period 서버 미강제.",
      "failReason": "2주 상한(BR-1)이 서버에서 안 막힘", "cause": "S4" },
    { "test_id": "API-EP-loan-create", "type": "normal", "role": "직원",
      "pass": true, "evidence": "normal:201 out형태OK · access(미인증):401 · rule(15일):400 · input(목적빈값):400" }
  ],
  "gaps": [
    { "kind": "rule", "ref": "BR-8", "missing": "외부 도메인 로그인 거부 경로 미확인", "evidence": "…", "cause": "S4", "severity": "high" },
    { "kind": "feature", "ref": "F-072", "missing": "부서별 집계 합계가 실제 대여 수와 불일치", "evidence": "관찰 3 vs 실제 5", "cause": "S3" }
  ],
  "notes": [
    { "title": "의심보안(사람 후속)", "detail": "/equipment 검색이 <script> 페이로드를 이스케이프 안 하고 heading 반영", "evidence": "screenshots/031-xss.png" }
  ]
}
```
필드 규율:
- `results[]`: 대본의 **모든** uiTests·apiTests id 포함(+ 발견/적대분). `test_id`=대본 id 그대로(커버리지 매칭). `pass`(bool) 필수. `fail`이면 `evidence`(관찰 사실) + `failReason` + **`cause`**(S2|S3|S4) 필수. 서버측 하위판정을 별 결과로 나눌 땐 `-server`/`-access` 접미(단, 대본 원본 id는 반드시 하나 존재).
- `gaps[]`: 폭/drift 누락. `ref`·`missing`·`evidence`·`cause`. `severity`(high/medium/low) — low/info는 비차단. 없으면 차단으로 간주.
- `notes[]`: 비차단 관찰(의심보안·개선점). pass/fail 불변.
- **cause 판정 기준**: 셀렉터 미부여·로직 오류·4xx 미반환·상태전이 안 됨 → **S4** / 화면·필드·플로우·엔드포인트 자체 없음 → **S3** / 요건이 spec에 아예 없음·모호 → **S2**.

# STEP 3 — finalize 실행 (당신이 Bash로)
```bash
node skills/s5-qa/run.mjs finalize <project>
```
finalize가: 스키마·근거 검증 → **커버리지 교차검증**(UI 미실행 있으면 하드 실패 → 마저 실행 후 재실행) → pass/fail + 루프백 판정 → `qa-result.json`/`.md` 렌더 → 서버 종료 → git commit. 결과를 사람에게 요약(통과/실패/gap/루프백).

## 판정 규율 (요약)
- **근거 필수**: 모든 fail은 실행 근거(스냅샷/DOM/네트워크/콘솔)와 함께. 근거 없는 판정 금지.
- **바닥은 우회방지 최소선**: UI 테스트 통과가 전부가 아니다 — API 규칙강제·접근제어·폭에서 teaching-to-test를 잡는다.
- **커버리지**: 대본 UI 전부 실행(silent-drop 금지). 못 만든 전제(seed)는 fail이 아니라 gap/note로 정직하게.
- **루프백**: 셀렉터/로직/상태전이 실패→S4 · 화면/필드/엔드포인트 누락→S3 · 요건 미명세→S2. 여러 원인이면 가장 상류로. cap 2~3회.

## 원칙 (DESIGN.md 준수)
전체 데이터 다 넣고·규칙 적게·모델 신뢰(폭 판정은 당신). 가드는 코드(입력·qa-result 스키마·커버리지·루프백=`guard.mjs`). 얇게·도메인 불가지(롤·경로·enum·셀렉터는 계약에서 — gearloan 하드코딩 금지). `lib/version`(commit·stale)·`lib/clean` 재사용.

## 선행조건
- S4 빌드 그린(`runs/<project>/app`). 없으면 prep이 안내 후 중단(→ S4 필요).
- chrome-devtools MCP 연결 필요. 미연결이면 STEP 2 불가 — 사용자에게 MCP 활성화 요청.
