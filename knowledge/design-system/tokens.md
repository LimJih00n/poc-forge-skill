# 디자인 토큰 (dealcatch proposal-site `globals.css` distill)

> 출처: `bigshift-projects/dealcatch-v2` `proposal-site/app/globals.css`(최신 main 확인). 색·간격만이 아니라 **미감 규율**을 토큰으로 고정 — S3(목업 프롬프트)·S4(실앱 스캐폴드/코드젠) 공용.
> **도메인 불가지 원칙**: 브랜드색(accent)은 프로젝트 spec에서 도출해 오버라이드하되, *스케일·리듬·그림자·타이포 위계*는 이 시스템 고정.

## 팔레트

| 역할 | 값 |
|---|---|
| bg / surface | `#ffffff` |
| surface-muted (페이지 배경) | `#f7f9fc` · `#f6f8fb` |
| ink (본문) | `#111827` |
| text-secondary | `#526174` |
| muted | `#64748b` |
| line | `#d9e2ec` · soft `#e7edf4` |
| **accent (primary)** | `#2779eb` → strong `#1f6feb` · 틴트 bg `#eaf2ff` · 틴트 text `#174ea6` |
| accent-secondary | `#7c5cc4` · 태그 bg `#f4f0ff` text `#5b3ea4` |
| success | text `#17684a` · bg `#e8f7f0` · border `#b9ddce` |
| warning | text `#8a5a11` · bg `#fff4dc` · border `#f3d7a6` |
| dark surface (admin 사이드바) | `#172033` · on-dark text `#ffffff` / muted `#b8c7da` |

> **accent = 브랜드색 슬롯**(프로젝트별 도출·오버라이드). 나머지 중립·시맨틱은 고정.

## 라운드 (radius)
`8px`(컨트롤·카드·칩) · `16px`(피처카드·프레임) · `24px`(패널) · `999px`(pill/배지 점)

## 그림자 (soft·대형 blur·쿨톤 — 그림자로 위계, 테두리 최소)
- card: `0 16px 36px rgba(25,47,80,.06)`
- elevated: `0 22px 56px rgba(15,23,42,.08)`
- panel: `0 24px 52px rgba(15,23,42,.1)`

## 타이포
- family: **Pretendard**, fallback `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
- 본문 weight 400–500 / **라벨·배지·강조 700–900**(강조는 색대비·크기·간격 우선)
- 스케일: h1 `2rem`/line 1.16 · h2 `1.14rem`/1.35 · body `1rem`/1.6 · 라벨 `0.82–0.9rem` UPPERCASE 800 · small `0.68–0.78rem`
- **`word-break: keep-all`** (한국어 줄바꿈)

## 간격 리듬 (px 스케일)
`4 · 6 · 8 · 10 · 12 · 14 · 16 · 18 · 22 · 24` — gap·padding 이 스케일에서만.

## 컴포넌트 언어
- **Card**: 흰 bg + `1px #d9e2ec` 테두리 + radius 8, 필요 시 soft shadow. 상단 미디어는 `aspect-ratio 16/10`, 회색 placeholder(`#eef3f8`).
- **Badge(시맨틱)**: 틴트 bg + 같은계열 테두리 + 진한 텍스트, radius 8, weight 900, `0.76rem`. (성공=그린, 경고=앰버, 중립=`#f8fafc`/`#526174`)
- **Filter chip**: 테두리 pill, 선택(`aria-pressed`) → bg `#eaf2ff` + border `#1f6feb` + text `#174ea6`. 우측에 카운트 pill.
- **Button**: primary = accent bg + 흰 텍스트 / secondary = `1px` 테두리 + ink. radius 8(폼) 또는 999(주요 CTA). weight 700–900.
- **KPI 타일**: 틴트 bg `#eaf2ff` + text `#174ea6`, radius 8, weight 900.
- **불릿**: 텍스트 앞 accent 점(5px, radius 999).
- **상태 틴트**: hover 시 은은한 bg 틴트(`#edf4fb`).
- **모션**: 160–180ms, `cubic-bezier(.2,.8,.2,1)`(또는 `.16,1,.3,1`).

## 화면유형별 우선순위 (톤 메모 반영)
- **admin/운영툴**: 명확한 표·필터·상태 배지·조작 버튼 우선.
- **consumer**: 첫 viewport CTA·카드 비율·이미지/텍스트 밀도 우선.
- 공통: **동일 프로젝트 전 화면은 하나의 팔레트·컴포넌트 언어**로 통일(coherence).

---

## ▶ 프롬프트 주입용 압축 블록 (INJECT)
> S3 이미지 프롬프트 / S4 codegen 프롬프트에 그대로 붙이는 요약. `{{ACCENT}}`만 spec에서 치환.

```
[디자인 시스템 — 정갈한 모던 SaaS(Toss/HeroUI 계열)]
· 팔레트: 흰 서피스(#fff)·페이지 #f7f9fc, 잉크 #111827/보조 #526174/muted #64748b, 라인 #d9e2ec,
  브랜드 accent {{ACCENT|#2779eb}}(강조 틴트 bg #eaf2ff·text #174ea6), 시맨틱 성공 #17684a/#e8f7f0·경고 #8a5a11/#fff4dc.
· 라운드 8/16/24/999. 그림자는 부드럽고 크게(0 16px 36px rgba(25,47,80,.06)) — 테두리 최소, 그림자로 위계.
· 타이포 Pretendard, 본문 가볍게(400–500)·라벨/배지 굵게(700–900), 강조는 색대비·크기·간격으로, 한국어 word-break:keep-all.
· 간격 4/6/8/10/12/14/16/18/22/24 리듬. 흰 카드+얇은 라인, 시맨틱 틴트 배지, pill 필터칩(선택 시 틴트),
  primary=accent채움·secondary=테두리, accent 점 불릿, hover 은은한 틴트, 모션 160–180ms.
· 콘텐츠 이미지=회색 placeholder. 전 화면 하나의 팔레트·컴포넌트 언어로 통일.
```
