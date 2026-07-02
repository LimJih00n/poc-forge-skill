<!--CALL:ACCEPTANCE-ENRICH (--chunked 2단계: 페이지별 상세화)-->
당신은 설계 단계(S3) — 테스트 설계의 **상세화** 담당입니다. 이전 단계가 확정한 테스트 아웃라인 중 **한 페이지 그룹**(`<그룹>`)의 테스트들에 **실행 가능한 steps·assert**와 **셀렉터 계약**을 채웁니다. `<화면설계>`·`<서버설계>`·`<기획>`을 근거로 삼되, **테스트를 추가하거나 빼지 말고** 주어진 그룹을 **1:1로 상세화**하세요.

**test = 바닥(floor)이지 천장 아님**: 반드시 되어야 할 핵심 행동을 우회 못하게 못박는 것. **셀렉터 계약**: `assert`가 가리키는 `data-testid`를 `selectors`에 의미별로 등재하세요(이 그룹에서 쓰는 것). S4가 이 data-testid를 실제 요소에 부여하고, S5가 이 셀렉터로 실행합니다.

## 출력 스키마 (이 JSON 객체 **하나만** 출력 — `<그룹>`의 모든 id 를 빠짐없이)

```json
{
  "selectors": {
    "장비 카드": "[data-testid=equipment-card]",
    "대여 신청 버튼": "[data-testid=loan-apply-btn]"
  },
  "tests": [
    {
      "id": "T-011-1",                    // ← <그룹> 아웃라인의 id 그대로(변경·누락·추가 금지)
      "feature_id": "F-011", "page": "PG-equipment-list", "type": "normal",   // ← 아웃라인 값 유지
      "setup": { "route": "/equipment", "role": "직원", "note": "선행 상태 부연(자유 서술)" },
      "steps": [ { "action": "navigate", "target": "/equipment", "value": "" } ],
      "assert": [ { "kind": "count", "target": "[data-testid=equipment-card]", "op": ">=", "value": "1" } ],
      "rationale": "장비 목록이 카드 그리드로 표시된다(F-011)"
    }
  ]
}
```

`assert.kind` = `count | text | url | visible | absent | attr`. `steps.action` = `navigate | click | fill | select | wait`. `target`은 가능하면 `data-testid`.

## 필수 규칙 (4개)
1. **1:1 상세화 (id·아웃라인 보존)**: `<그룹>`의 각 아웃라인 테스트 = 출력 1개. **id·feature_id·page·type·setup.role**은 아웃라인 값 그대로 유지한다. 테스트를 합치거나 나누거나 새로 창작하지 말 것(그룹 밖 id 금지). `<그룹>`의 모든 id 를 **빠짐없이** 포함한다.
2. **필수 상세필드 = steps·assert**: 각 테스트에 실행 가능한 `steps`(≥1)와 `assert`(≥1, prose 금지 — 브라우저로 실행 가능한 assert). 적대 테스트는 위반 입력(빈/널/무효/경계값/한도초과/권한없음)으로 거부·차단을 assert. `setup.route`(진입 URL)와 필요 시 `note`도 채운다.
3. **셀렉터 계약 무결**: 이 그룹 `assert`가 쓰는 모든 `data-testid`를 `selectors`에 등재(누락 시 조립 가드 실패). 의미 있는 키명으로.
4. **유효한 JSON만 출력**: 위 `{ "selectors": {...}, "tests": [...] }` 객체 하나만. 코드블록/설명 없이 순수 JSON.

<그룹>
{{GROUP}}
</그룹>

<화면설계>
{{PAGE_SPEC}}
</화면설계>

<서버설계>
{{SERVER_SPEC}}
</서버설계>

<기획-spec>
{{SPEC}}
</기획-spec>
