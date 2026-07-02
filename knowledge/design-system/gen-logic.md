# 화면 생성 로직 · 프롬프트 (dealcatch `generate-ux-suggestions.mjs` + lokmedia `generate_demo.py` 이식)

> ★ 이 문서가 "색만 차용"이 아닌 이유 — dealcatch/lokmedia가 **좋은 목업을 뽑는 실제 프롬프트 엔지니어링·생성 전략**을 poc-forge S3가 그대로 들고 쓰도록 이식.
> 출처: `bigshift-projects/dealcatch-v2` `scripts/generate-ux-suggestions.mjs`(최신 main 확인, 디자인 프롬프트 로직 불변) · `lokmedia/prep_work/generate_demo.py`(레퍼런스 체이닝).

---

## 1. 이미지 프롬프트 프레이밍 (dealcatch `buildImagePrompt`)

핵심은 4가지 — **① 원 요구사항 전량 컨텍스트 주입 · ② "제안용 UX 화면" 목적 · ③ "디자이너가 완성한 피그마 UI 목업 시안처럼" · ④ 강한 브랜드 안전.**

원본(dealcatch) 프롬프트 골격:
```
다음은 {sourcePlatform} 내에서 가져온 업무 내용 / 프로젝트 설명 부분입니다.
---
{projectDescription}
---
위 요구사항을 토대로 만들어질 서비스 중 {서비스/화면}에 대한 제안용 UX 화면 이미지 1장을 생성해줘. {flowInstruction}
디자이너가 완성한 피그마 UI 목업 디자인 시안처럼 생성해줘. "이런 식으로 만들거다"라고 고객사에게 전달하기 위한 목적이야.
로고나 서비스 이름에서 실재하는 로고나 서비스 이름을 사용하지 않도록 주의해줘.
화면 안의 제품 사진·썸네일·예시 상품에도 실재하는 명품 브랜드 로고·모노그램·상표·트레이드마크·식별 가능한 시그니처 패턴을 넣지 마. 무브랜드 더미 상품처럼 보여줘.
```

### poc-forge 적응 (S3)
poc-forge는 `page-spec.json`의 페이지별로 **실제 다중 페이지 앱**을 만들 것이므로, dealcatch의 "한 이미지에 플로우 여러 컷"과 달리 **페이지당 1화면**을 뽑되, 위 프레이밍은 그대로:
```
[프로젝트 컨텍스트: spec.product + 해당 page의 purpose/fields/states/actions]
위 요구사항의 {page.purpose} 화면 1장을, 디자이너가 완성한 피그마 UI 목업 시안처럼 생성.
· 이 페이지에 있어야 할 것: {page.components / fields / states / actions 에서 도출}
· {디자인 시스템 INJECT 블록 (tokens.md)}
· {화면유형 프레이밍 (아래 2)}
· 브랜드 안전: 실재 로고/서비스명/명품 브랜드·모노그램·트레이드마크 금지, 콘텐츠=무브랜드 더미/회색 placeholder. 브랜드명은 spec 값만.
· landscape 16:9, 한국어 라벨, 고해상.
```
> 기존 `commonImagePrefix`(최소 톤)를 **이 프레이밍 + tokens.md INJECT + 화면유형 프레이밍**으로 승격.

---

## 2. 화면유형별 flowInstruction (dealcatch, 검증된 문구)

dealcatch가 화면유형별로 다르게 지시하는 것이 coherence·품질의 비결. 원문:

| 유형 | flowInstruction |
|---|---|
| **모바일 앱** | "서로 이어지는 플로우상에 있는 핵심 스크린 5개가 가로로 나열된 모습. 모든 화면은 같은 레이아웃, 화면비 9:16." |
| **태블릿/데스크톱** | "서로 이어지는 플로우상 핵심 스크린 4개가 2×2 그리드. 모든 화면은 같은 레이아웃, 화면비 16:9." |

+ 화면유형 우선순위(tokens.md 재게시): **admin=표·필터·상태배지·조작버튼 / consumer=첫 viewport CTA·카드비율·밀도.**

> poc-forge 페이지당 1화면 모드에선 "이어지는 N컷"은 생략하되, **화면유형(admin/consumer/tool)별 강조점**은 page.roles/url·spec로 도출해 프롬프트에 주입. (플로우 전체를 한 장에 보고 싶으면 dealcatch식 N컷 모드를 옵션으로.)

---

## 3. 세트 일관성 — 레퍼런스 이미지 체이닝 (lokmedia `generate_demo.py`)

여러 화면이 "서로 다른 앱처럼" 보이면 실패. lokmedia 기법 = **대표 화면 1장을 정성껏 뽑고, 나머지는 그것을 레퍼런스로 편집 생성**:

- 모델: `openai/gpt-image-2/edit` + `image_urls: [hero, ...]` (fal). 일반 generate 아님.
- 지시 패턴(원문 요지): *"FIRST 레퍼런스 이미지의 시각 아이덴티티(팔레트·브랜드·컴포넌트)만 유지하고, (필요 시) SECOND 레퍼런스의 구조/리듬을 참고하되 그 색/로고는 복제하지 마."*
- 효과: 팔레트·컴포넌트 비례·미감이 세트 전체에 전파 → 한 앱처럼.

### poc-forge 적응 (S3, 옵션 `--ref-chain`)
1. page-spec에서 **대표 페이지 1장**(예: 대시보드/홈) 먼저 렌더(tokens+프레이밍 풀 주입).
2. 나머지 페이지는 `gpt-image-2/edit` + `image_urls:[대표화면]` + "이 레퍼런스의 팔레트·컴포넌트 언어 유지, 이 페이지의 구조로" 로 렌더.
3. 실패/키없음 시 독립 generate 폴백(현행).

---

## 4. 부수 규율 (dealcatch)

- **prompts.md 기록**: 각 화면에 쓴 프롬프트를 `screens/prompts.md`로 남김(투명성·디버그·재현).
- **stale 정리**: 계약이 바뀌어 화면 수/구성이 달라지면 옛 이미지 prune(현 S3도 `renderScreen` 기준 정리 중 — 유지).
- **brand-safety는 하드 규율**: 실재 로고/명품 상표 절대 금지(법적·품질). 프롬프트 말미에 항상.

---

## 5. S4(실앱)로의 연결

S4는 이미지가 아니라 **코드**를 만들지만 같은 디자인 언어를 상속해야 목업↔실앱이 일치:
- `prompt-codegen.md`에 **tokens.md INJECT 블록 + 컴포넌트 언어**를 주입("이 토큰/컴포넌트 언어로 Tailwind 구현").
- 스캐폴드 `globals.css`/`tailwind.config`에 토큰(색·간격·라운드·그림자·타이포)을 **CSS 변수/테마로 베이킹** → 생성 컴포넌트가 자동 상속.
- `components/ui.tsx` 프리미티브(Button·Card·Badge·Chip·KPI…)를 이 컴포넌트 언어로 → 페이지가 조합.
