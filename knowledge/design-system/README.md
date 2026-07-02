# poc-forge 디자인 시스템 (vendor) — dealcatch 차용

poc-forge 화면·앱의 **미감을 하나의 언어로 통일**하기 위해, dealcatch(및 lokmedia)의 검증된 디자인 자산을 vendor한 것. 지향점 = **정갈하고 세련된 모던 SaaS(Toss/HeroUI 계열)** — 여백·정보 위계·부드러운 그림자·일관된 컴포넌트 언어.

> **핵심 원칙(사용자 결정)**: 색만 베끼는 게 아니라 **디자인을 *생성*하는 로직·프롬프트**까지 들고 온다. Astryx(컴포넌트 라이브러리)는 배제 — Tailwind + 이 vendor로 간다(알파 의존성 리스크 회피, 완전 통제, 전환문 열어둠).

## 3층 구조

| 파일 | 내용 | 소비 |
|---|---|---|
| `tone/design-heroui.md`·`design-toss.md` | 톤 규율(밀도·여백·정보위계·Pretendard·화면유형 우선순위) | S3 프롬프트 |
| `tokens.md` | globals.css distill — 팔레트·라운드·그림자·타이포·간격·컴포넌트 언어 + **프롬프트 주입용 압축 블록** | S3 + S4 |
| `gen-logic.md` | ★생성 로직/프롬프트 — 피그마 목업 프레이밍·화면유형별 flowInstruction·브랜드안전·레퍼런스 체이닝 | S3 (+ S4 연결) |

## 두 소비자

- **S3 (목업 생성)**: `s3-design/run.mjs`의 이미지 프롬프트(`commonImagePrefix`/페이지 프롬프트)를 `gen-logic.md` 프레이밍 + `tokens.md` INJECT 블록으로 승격. `--images-only`로 값싸게 반복.
- **S4 (실앱 구현)**: 스캐폴드 `globals.css`/`tailwind.config`에 토큰 베이킹 + `components/ui.tsx`를 컴포넌트 언어로 + `prompt-codegen.md`에 톤 주입 → 생성 앱이 미감 상속. **목업↔실앱 일치.**

## 도메인 불가지 (흔들지 말 것)

- **브랜드색(accent)** = 프로젝트 `spec`에서 도출해 `{{ACCENT}}` 오버라이드.
- **미감 규율**(스케일·리듬·그림자·타이포 위계·컴포넌트 언어) = 이 시스템 고정.
- 특정 도메인(작품/장비/할일…) 하드코딩 금지. 콘텐츠 아트 = 회색 placeholder / 무브랜드 더미.

## 출처·신선도

- dealcatch = `bigshift-projects/dealcatch-v2`(GitHub main, 2026-07 확인). 디자인 프롬프트 로직·톤 메모 = 최신과 동일, 토큰은 최신 `proposal-site/app/globals.css`(14.8k줄) distill.
- lokmedia = `lokmedia/prep_work/generate_demo.py`(레퍼런스 체이닝).
- 갱신 시: 최신 globals.css `:root` + `buildImagePrompt`/`flowInstruction` 재확인.
