---
name: poc-forge
description: poc-forge 파이프라인 전체를 관장하는 오케스트레이션 스킬 — "계획 → 실제 돌아가는 서비스". S1(이해)→S2(기획)→S3(설계)→S4(개발)→S5(QA) 5컴포넌트를 순서·사람게이트·빌드그린·루프백을 강제하며 엮는다. 얇은 엔진(orchestrator/*.mjs)이 manifest 로 "다음 뭐할지"를 결정하고(순수 판단), 실제 실행(스테이지 서브프로세스·S4 서브에이전트 코드젠·S5 chrome-devtools MCP 구동·사람 게이트)은 Claude 가 한다. 멀티 프로젝트(runs/<project>/) 목록·상태·이어하기. "poc-forge 돌려", "gearloan 파이프라인", "이어서 진행", "poc-forge 상태" 시 사용. 도메인 로직 0 — 각 컴포넌트 스킬(skills/sN-*/)이 자기 역할을 최상급으로 하고, 이 스킬은 그들을 관장만 한다.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Agent
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
  - mcp__chrome-devtools__select_page
---

# poc-forge 오케스트레이터

**정체성**: 계획 → *실제 돌아가는* 서비스. 5컴포넌트(S1~S5)를 **순서·게이트·빌드그린·루프백**을 코드로 강제하며 엮는다. 도메인 로직 0.

**분업(흔들지 말 것)**:
- **엔진(`orchestrator/engine.mjs` + `pipeline.mjs`) = 두뇌.** manifest 로 "다음 한 가지"를 결정만. 스테이지를 절대 spawn 하지 않음. 순수함수(단위검증됨).
- **이 SKILL(Claude) = 손.** 엔진이 정한 액션을 실제로 실행: 스테이지 서브프로세스 / S4 서브에이전트 / S5 MCP 구동 / 사람 게이트.
- **`orchestrator/cli.mjs` = 엔진의 얇은 CLI.** Bash 로 호출해 결정을 받고(=stdout JSON) 결과를 기록. 이게 엔진과 대화하는 유일한 창구.
- **`runs/<project>/poc.manifest.json` = 상태.** stages{status,gate}·round·loopbacks. (git 추적됨.)

작업 디렉토리는 항상 `poc-forge/`. 모든 명령/스테이지는 여기서.

---

## 시작하기

1. **프로젝트 해석**: 사용자가 이름을 주면 `<project>`(→`runs/<project>/`). 신규면 `runs/<project>/sources/`에 자료가 있어야 한다(S0 수집은 아직 수동 — 없으면 자료부터 요청).
2. **유인/무인 결정(사용자 결정 #5, 시작 시 1회)**: 기본은 **유인**(각 게이트에서 사람 승인). 사용자가 "무인/알아서/한번에"를 원하면 `--auto`(게이트 자동승인).
   ```bash
   node orchestrator/cli.mjs init <project> [--auto]
   ```
3. 이후는 **메인 루프**를 돈다.

---

## ★ 메인 루프

매 턴:
```bash
node orchestrator/cli.mjs next <project>     # 신선도 자동 갱신 + 다음 액션(JSON)
```
반환된 `type`에 따라 분기한다. **한 번에 한 액션**(엔진이 직렬화 — commit footgun 때문에 스테이지 동시 실행 금지).

### `type: "run"` — 스텝 실행
엔진이 준 `stepId`·`kind`·`cmd`대로 실행하고 결과를 기록:
```bash
node orchestrator/cli.mjs start  <project> <stepId>          # running 표시(선택)
# ... 실제 실행 ...
node orchestrator/cli.mjs record <project> <stepId> <exitCode>   # 마커 재검증 후 done/failed
```
- **`kind: "stage"`** → `cmd` 그대로: `node <cmd...>` (예 `node skills/s2-plan/run.mjs <project>`). exit code 를 `record` 에 넘긴다. 엔진이 성공 마커(디스크)를 **재검증**하므로 exit0 이어도 산출이 없으면 failed 처리된다.
  - stderr 로그가 스테이지 진행/사유를 보여준다(stdout 은 비어 있음 — exit code 로 판단).
  - **S3 는 2-phase**: 스텝 `s3-ui`(`--phase=ui`)와 `s3-design`(`--phase=design`)이 별도 스텝으로 이미 분리돼 있다. ui 실행 후 화면 게이트(아래), 승인되면 엔진이 `s3-design` 을 다음으로 준다.
  - **S4 코드젠 마찰(핸드오프 §7b)**: 이 호스트에서 `node skills/s4-build/run.mjs` 의 `claude -p` 동시풀(레이어 C/api·E/pages 3-wide)이 백그라운드에서 throttle/사망할 수 있다. 그럴 땐 **run.mjs 대신 서브에이전트 병렬 코드젠**으로 실행(웨이브: seed·도메인lib·ui → api·layout·pages, 각 에이전트가 계약+앞 레이어 export 를 Read 하고 tsc 클린). 빌드 그린 확보 후 동일하게 `record s4 0`. (또는 정상 호스트면 run.mjs 한 방.)
- **`kind: "claude-mcp"`** (스텝 `s5-mcp`) → **`skills/s5-qa/SKILL.md` STEP2 를 따라** chrome-devtools MCP 로 앱을 구동한다(prep 이 이미 서버를 띄워 뒀다). Discover→UI→API→적대→폭 → `runs/<project>/qa-result.raw.jsonl` 작성. 끝나면 `record s5-mcp 0`.
  - 로그인은 `evaluate_script` fetch(한글 안전·쿠키 자동), 상호작용은 네이티브 click/fill, assert 는 evaluate_script querySelector. 접근거부=200+`forbidden` 셀렉터. (상세=s5-qa SKILL.)

### `type: "await-gate"` — 사람 게이트
엔진이 `stepId`·`question`(+`precondition`)을 준다. **해당 스텝의 산출물을 사용자에게 제시**하고 질문한다:
| 게이트 | 보여줄 것 |
|---|---|
| s1 | `understanding.md` (모순·오픈질문·자산 커버리지) |
| s2 | `features.md`(기능정의서)·`prd.md` |
| s3-ui | `screens/*.png`·`page-spec.md` (화면 게이트) |
| s3-design | `dev-doc.md`·schema·server-spec·acceptance |
| s4 | 빌드그린 확인 + (선택) 앱 실제 동작 리뷰 |

- **유인 모드**: 사용자가 "승인/OK" → `node orchestrator/cli.mjs approve <project> <stepId>` (커밋됨). "수정 필요" → 그 스텝을 **다시 실행**(전체 재도출; 필요하면 사용자 피드백을 `sources/`에 추가 후 상류부터).
- **무인 모드**(`mode: "unattended"`): 확인 없이 바로 `approve`. 단 **s4 빌드그린·s5 판정처럼 코드가 강제하는 게이트는 유지**(엔진이 마커/판정으로 이미 막음).

### `type: "loopback"` — S5 실패 → 원인 단계로
엔진이 `loopback{stage,reason}`·`targetStep`을 준다. 사용자에게 **무엇이 왜 실패해 어디로 되돌아가는지** 알린 뒤:
```bash
node orchestrator/cli.mjs loopback <project>    # 착지 스텝 + 하류 전부 pending 리셋, round++, 커밋
```
그리고 루프를 계속(→ 엔진이 착지 스텝부터 다시 `run` 을 준다 = 순방향 재흐름). **S3 원인이면 화면(s3-ui)부터** 재검토된다(사용자 결정).

### `type: "done"` — PASS
`qa-result.md` 요약(차원별·폭·notes)을 사용자에게 보고. 파이프라인 완료.

### `type: "blocked"` — 사람 개입 필요
- `루프백 cap(2) 초과`: 같은 문제가 2라운드 반복 → 자동 진행 중단. 사용자와 근본 원인을 논의.
- `판정 이상(passed=false·loopback=null)`: qa-result 의 원인 문자열이 오염/무효 → raw 를 점검(정상 pass 로 오판 금지).

---

## 멀티 프로젝트 관리

```bash
node orchestrator/cli.mjs list                  # runs/* 전 프로젝트: mode·round·다음 액션
node orchestrator/cli.mjs status <project>      # 한 프로젝트 요약 + 다음 액션
```
- **이어하기**: fresh 세션은 `status <project>` 로 manifest 를 읽고 `current`/다음 액션에서 재개. 상태는 전부 디스크(manifest + 계약파일)라 세션 경계 무관.
- **신선도**(DESIGN §10 핵심위험): `next`/`status`가 매번 상류 계약 지문을 재계산 → 상류가 바뀌었으면 하류를 `stale` 로 표시하고 게이트 재승인을 요구한다. 즉 사용자가 `sources/`에 답변을 추가하고 S1 을 다시 돌리면, 엔진이 S2~S5 를 stale 로 잡아 다시 흘려보낸다.

---

## 주의 (값비싼 교훈)

- **엔진은 결정, 실행은 나(Claude).** cli 의 stdout=JSON 결정, stderr=사람용 요약. 스테이지 성공은 exit code 를 **믿지 말고** 엔진의 마커 재검증(record 결과)으로 판단.
- **직렬화**: 스테이지 자동커밋이 `git add -A`(repo 루트)라 동시 실행 시 서로의 변경을 쓸어담는다. 엔진이 한 번에 한 액션만 주는 이유. 절대 병렬로 스테이지 돌리지 말 것(S4 서브에이전트 코드젠은 한 스테이지 내부라 무관).
- **S5 서버 정리**: prep 이 detached 서버를 띄운다. finalize 가 트리 종료하지만, 중간에 멈추면 서버가 남을 수 있다 → 필요 시 `.s5-server.json` 의 pid 로 정리.
- **각 컴포넌트 스킬은 독립 실행 가능**하다. 디버깅 땐 오케 없이 `node skills/sN-*/run.mjs <project>` 를 직접 돌려도 된다(계약 파일로 연결).
- **얇게 유지**: 새 규칙이 생기면 프롬프트가 아니라 **엔진(코드)** 에. 도메인 지식은 절대 이 스킬에 넣지 말 것.
