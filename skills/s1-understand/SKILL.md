---
name: s1-understand
description: poc-forge 파이프라인의 S1(이해·정리). 한 프로젝트에 대해 여러 루트로 들어온 로우데이터(sources/의 통화·이메일·채팅·기존자료·견적·제안서 등)를 하나도 빠짐없이 정독해 통일된 정리본으로 만든다 — context.json(기계용) + understanding.md(사람용). 근거 링크·모순·오픈질문을 코드 가드로 강제. 단독 실행 가능한 컴포넌트 스킬.
---

# S1 · 이해·정리 (understand)

poc-forge 5컴포넌트의 첫 단계. **수집(S0)은 별개** — 여기서는 `sources/` 폴더에 로우데이터가 이미 쌓여 있다고 가정하고, 그걸 **자세히 이해하고 정리**하는 것만 한다. "무엇을 만들지"를 정하지 않는다(그건 S2). 오직 *지금 소스에 무엇이 담겨 있는가*를 정확히 파악한다.

## 언제 쓰나
- 새 프로젝트의 지저분한 입력들(제안서·통화내역·채팅·견적서·기존 엑셀 설명 등)을 한 폴더에 모아둔 뒤, 기획(S2) 전에 통일된 이해 기반을 만들 때.
- 단독으로도, poc-forge 오케스트레이터의 첫 스테이지로도 실행된다.

## 입출력 계약
- **IN**: `<projectDir>/sources/` 의 텍스트 파일 전부 정독 (`.md .txt .csv .tsv .json .log`); 이미지·바이너리(pdf 등)는 본문은 안 읽되 **`assets[]`에 목록 등재(필수, `readable:false`)** — 뒤 단계가 꺼내 쓸 인덱스
- **OUT**:
  - `<projectDir>/context.json` — 기계용 구조화 (다음 단계 S2가 소비하는 계약)
  - `<projectDir>/understanding.md` — 사람용 정리본 (context.json에서 **결정적으로 렌더** → 항상 일치)

## 내부 단계
1. **인테이크** (코드, `run.mjs`) — sources/ 전부를 하나의 코퍼스로 로드. **truncate 없음**(전체 데이터를 다 넣는다).
2. **이해·정리** — 코퍼스 전부를 넣고 통일 스키마로 정리. 두 방식:
   - **단일콜(기본, `prompt.md`)** — 한 번에 전체 context (`summary · facts[] · entities[] · glossary[] · contradictions[] · openQuestions[] · scopeSignals[] · assets[]`). 잘림 감지 + 재시도(`lib/llm.mjs generateJson`).
   - **청크(`--chunked`, `prompt-plan.md`+`prompt-enrich.md`)** — opt-in. S2식 **"skeleton-완결 → assets 배치별 상세화 + jsonl 체크포인트"**(아래). context.json은 작아 적합도는 S2보다 낮음.
   프롬프트 = **역할 + 출력 스키마 + 필수 규칙**(근거기반 · 지어내기/임의봉합 금지 · 유효 JSON). 미시규칙 없이 모델을 신뢰.
3. **가드** (코드, `guard.mjs`) — 프롬프트가 아니라 **코드로** 계약 강제:
   - 스키마 유효성 (필수 배열/필드)
   - **근거 무결**: 모든 fact에 sources 필수, sources는 *실존 파일명*이어야 함(지어냄 차단)
   - **커버리지(hard)**: 모든 소스 파일이 `assets[]`에 등재(silent-drop 금지). 근거(facts 등) 활용 여부는 warn으로 표면화(누락 가능성 알림).
   - 실패 시 hardFail → `context.invalid.json` 덤프 + 종료코드 1.
   - 청크는 추가로 `validateContextPlan`(skeleton+아웃라인)·`validateEnrichedAssets`(1:1 상세화)·`assetsCoverage`(조용한 드롭 hard).

### --chunked 방식 상세 ("skeleton-완결 → assets 배치별 상세화 + jsonl 체크포인트")
S1 context.json은 작고(~8K) 여러 이질 배열이라 청크 적합도가 낮다 → **지배적·결정적 배열 `assets`만** 청크하고 나머지는 skeleton 한 콜에 완결한다.
1. **skeleton 콜 1회** (`prompt-plan.md`) — 이해 본문 전부(summary·facts·entities·glossary·contradictions·openQuestions·scopeSignals) 완결. **`assets` 는 LLM이 출력하지 않음** — 코드가 **파일목록에서 아웃라인을 결정적으로 구성**(`{file, readable}` × 전 파일)해 주입한다(LLM이 파일을 드롭할 수 없음 = **커버리지 원천 보장**). → `.s1-plan.json`.
2. **assets 배치별 상세화 루프** (`prompt-enrich.md`) — 파일을 N개씩(기본 4) 배치로 나눠, 각 파일을 `{file, kind, readable, useFor, summary}` 풀 자산으로 **1:1 확장**(file 보존) → `.s1-assets.jsonl` append. 각 배치 작음 → 상세히·안 잘림.
3. **조립 + 가드** — jsonl 읽어 file dedup·아웃라인 순서 → context.json. readable 은 결정적 아웃라인이 권위(LLM 오분류 무시). `validateContext`(전체 재검증) + `assetsCoverage`(모든 아웃라인 파일 존재·배치별 ≥1 = **조용한 드롭 hard 차단**).
- **체크포인트/resume**: 중간 사망 시 완료 배치는 `.s1-assets.jsonl`에 보존. `--chunked --resume`이 기존 `.s1-plan.json` 재사용 + 완료 배치 skip. `--chunked`(resume 없음)는 fresh = skeleton 재생성·jsonl 폐기.

## 실행법
```bash
# 프로젝트명으로 호출(권장) → poc-forge/runs/<project>/ 대상 (멀티 프로젝트)
node skills/s1-understand/run.mjs gearloan                    # 단일콜(기본)
# 또는 경로를 직접 지정
node skills/s1-understand/run.mjs poc-forge/runs/gearloan

node skills/s1-understand/run.mjs gearloan --chunked          # 청크(assets 배치 상세화) — fresh
node skills/s1-understand/run.mjs gearloan --chunked --resume # 청크 이어하기(중간 사망 후)

# LLM 스왑 (테스트/목업)
POC_FORGE_LLM_CMD="node my-fake-llm.mjs" node skills/s1-understand/run.mjs gearloan
```
- 성공: `context.json` + `understanding.md` 생성, 통계 로그(facts·모순[해소]·질문[답변]·자산·커버리지).
- 디버그: LLM 원본은 `<projectDir>/.s1-llm-raw.txt`(단일콜) / `.s1-plan-raw.txt`·`.s1-enrich-raw.txt`·`.s1-plan.json`·`.s1-assets.jsonl`(청크, 전부 `.s1-` 접두라 gitignore) 에 저장.
- **주의(라이브 검증)**: `--chunked`는 결정적 코어(아웃라인 구성·배치 그룹핑·조립·resume·커버리지)를 단위검증했으나, **실 claude 프롬프트(skeleton/enrich) 품질은 실호스트 라이브 미검증**. 청크 출력 품질 ≥ 단일콜 확인 전까지 **단일콜이 기본**. S1은 산출이 작아 단일콜 잘림 위험도 낮음 → `--chunked`는 주로 resume 체크포인트/구조적 일관성용.

## 재실행 (누적·해소)
`sources/`는 **append-only로 누적**된다 — 오픈질문/모순을 고객에게 물어 받은 러프 답변을 그냥 `sources/`에 계속 넣으면 된다. **재실행하면 전체를 처음부터 재도출**(부분 패치 아님, `context.json`/`understanding.md` 덮어씀). 나중 라운드가 앞 충돌/질문을 확정하면 `status`를 `resolved`/`answered`로 바꾸고 `resolution`/`answer`에 무엇으로 정해졌는지 기록 → 재실행할수록 기획이 성숙(understanding.md에 `✅ 해소됨` / `✅ 답변됨`으로 분리 표시).

## 원칙 (DESIGN.md §4 준수)
- **전체 데이터 다 넣고, 규칙은 적게, 모델 신뢰.** 입력 truncate 금지.
- **표면화하되 봉합하지 않는다.** 소스 충돌 → `contradictions`, 미정·빈틈 → `openQuestions`. 임의 결론 금지.
- **가드는 코드로.** 근거·커버리지는 프롬프트 부탁이 아니라 `guard.mjs`가 강제.
- **얇게·도메인 불가지.** 특정 도메인 하드코딩 없음 — 어떤 프로젝트 소스든 동작.
