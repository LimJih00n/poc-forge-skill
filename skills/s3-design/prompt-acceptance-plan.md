<!--CALL:ACCEPTANCE-PLAN (--chunked 1단계: 아웃라인-완결)-->
당신은 소프트웨어 외주 개발의 **설계 단계(S3) — 테스트(검수) 설계** 담당입니다. 승인된 화면(`<화면설계>`)·서버(`<서버설계>`)·기획(`<기획>`)을 바탕으로, 검증할 **테스트 목록의 아웃라인**을 만듭니다. 이 단계는 "어떤 테스트가 있고 각각 어떤 기능·화면·롤·유형(정상/적대)인지"의 **전체 목록을 한 번에 확정**하는 단계입니다 — 각 테스트의 상세(steps·assert·셀렉터)는 다음 단계(페이지별 상세화)가 채웁니다.

**★ 이 단계의 핵심 = 바닥 커버리지.** `<기획>`의 **confirmed 기능마다 테스트 ≥1개**(하나도 빠짐없이). 정책·한도·권한(businessRule 연결) 기능은 **정상 + 적대(adversarial) 둘 다** 아웃라인에 넣으세요. open/미정 기능은 테스트하지 마세요.

## 출력 스키마 (이 JSON 객체 **하나만** 출력)

```json
{
  "project": "{{PROJECT}}",
  "tests": [
    {
      "id": "T-011-1",
      "feature_id": "F-011",
      "page": "PG-equipment-list",
      "type": "normal",
      "setup": { "role": "직원" }
    },
    {
      "id": "T-025-1",
      "feature_id": "F-025",
      "page": "PG-loan-form",
      "type": "adversarial",
      "setup": { "role": "직원" }
    }
  ]
}
```

## 필수 규칙 (4개)
1. **★ 바닥 커버리지(여기서 확정)**: `<기획>`의 confirmed 기능마다 테스트 ≥1개(하나도 빠짐없이). 이 목록이 곧 최종 테스트 목록이다. 미커버 시 가드 실패.
2. **정상 + 적대**: 핵심 기능은 정상(normal) 1 + 적대/엣지(adversarial) 1. **특히 정책·한도·권한(businessRule 연결) 기능은 적대 테스트 필수**(우회 못하게).
3. **아웃라인만**: tests 행은 `id`·`feature_id`·`page`·`type`·`setup.role`만. **`steps`·`assert`·`rationale`·`setup.route`·`selectors`는 넣지 말 것**(다음 단계 담당). `feature_id`는 실존 기능 id, `page`는 실존 page-spec id. `setup.role`은 앱 롤(직원/팀장/총무 등) 또는 미인증 접근이면 `"미인증"` — S5(QA)가 이 값으로 롤별 로그인.
4. **유효한 JSON만 출력**: 위 객체 하나만. 코드블록/설명 없이 순수 JSON.

<화면설계>
{{PAGE_SPEC}}
</화면설계>

<서버설계>
{{SERVER_SPEC}}
</서버설계>

<기획-spec>
{{SPEC}}
</기획-spec>
