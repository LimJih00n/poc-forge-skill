// orchestrator/pipeline.mjs — poc-forge 정적 파이프라인 정의. 스테이지를 "데이터"로.
//   순수(부작용 0). 엔진(engine.mjs)이 이 테이블을 걸어가며 판단만 한다 — 실행은 SKILL(Claude).
//   5 컴포넌트(S1~S5)를 8개 실행 스텝으로 전개: S3=ui→(사람)→design, S5=prep→(Claude MCP)→finalize.
//
//   각 스텝 필드:
//     id/stage/phase   식별
//     kind             "stage"(node run.mjs 서브프로세스) | "claude-mcp"(Claude가 chrome-devtools MCP 구동)
//     cmd(project)      stage 실행 argv(node 뒤). claude-mcp는 null.
//     reads[]           상류 계약 파일/디렉토리 — 신선도 지문의 근거(DESIGN §10)
//     produces[]        정본 산출(사람 확인용/다음 스텝 입력)
//     successMarker     디스크 재검증({files, mode:"all"|"any"}) — exit code 를 믿지 않고 마커로 확인
//     gate             사람 게이트({who,question[,precondition]}) | null. 모든 주요 스테이지에 사람 게이트.
//     terminal         s5-finalize 표식(loopback 판정 지점)

export const MAX_ROUNDS = 2; // 루프백 cap(사용자 결정) — 초과 시 blocked(사람 개입)

// S5 loopback.stage(S2/S3/S4) → 재실행 착지 스텝. S3 원인이면 화면(s3-ui)부터 재검토(사용자 결정).
export const LOOPBACK_LANDING = { S2: "s2", S3: "s3-ui", S4: "s4" };

export const STEPS = [
  {
    id: "s1", stage: "S1", kind: "stage",
    cmd: (p) => ["skills/s1-understand/run.mjs", p],
    reads: ["sources"],
    produces: ["context.json", "understanding.md"],
    successMarker: { files: ["context.json"], mode: "all" },
    gate: { who: "human", question: "이해가 맞아요? — understanding.md(모순·오픈질문·자산) 확인" },
  },
  {
    id: "s2", stage: "S2", kind: "stage",
    cmd: (p) => ["skills/s2-plan/run.mjs", p],
    reads: ["context.json", "sources"],
    produces: ["spec.json", "features.md", "prd.md"],
    successMarker: { files: ["spec.json"], mode: "all" },
    gate: { who: "human", question: "이 기획이면 돼요? — features.md(기능정의서)·prd.md 확인" },
  },
  {
    id: "s3-ui", stage: "S3", phase: "ui", kind: "stage",
    cmd: (p) => ["skills/s3-design/run.mjs", p, "--phase=ui"],
    reads: ["context.json", "spec.json"],
    produces: ["page-spec.json", "page-spec.md"],
    successMarker: { files: ["page-spec.json"], mode: "all" },
    gate: { who: "human", question: "이 화면이면 돼요? — screens/·page-spec.md 확인 (화면 게이트)" },
  },
  {
    id: "s3-design", stage: "S3", phase: "design", kind: "stage",
    cmd: (p) => ["skills/s3-design/run.mjs", p, "--phase=design"],
    reads: ["page-spec.json", "spec.json", "context.json"],
    produces: ["schema.json", "server-spec.json", "acceptance.json", "dev-doc.md"],
    successMarker: { files: ["schema.json", "server-spec.json", "acceptance.json", "dev-doc.md"], mode: "all" },
    gate: { who: "human", question: "이 설계면 돼요? — dev-doc.md·schema·server-spec·acceptance 확인" },
  },
  {
    id: "s4", stage: "S4", kind: "stage",
    cmd: (p) => ["skills/s4-build/run.mjs", p],
    reads: ["dev-doc.md", "page-spec.json", "schema.json", "server-spec.json", "acceptance.json"],
    produces: ["app/.s4-meta.json"],
    successMarker: { files: ["app/.s4-meta.json"], mode: "all" }, // 빌드그린일 때만 기록됨
    gate: { who: "human", question: "앱이 잘 도나요? — 빌드그린 확인 + 실제 동작 리뷰", precondition: "build-green" },
  },
  {
    id: "s5-prep", stage: "S5", kind: "stage",
    cmd: (p) => ["skills/s5-qa/run.mjs", "prep", p],
    reads: ["acceptance.json", "spec.json", "page-spec.json", "app/.s4-meta.json"],
    produces: [".s5-plan.json"],
    successMarker: { files: [".s5-plan.json"], mode: "all" },
    gate: null,
  },
  {
    id: "s5-mcp", stage: "S5", kind: "claude-mcp",
    cmd: null, // Claude 가 chrome-devtools MCP 로 직접 구동(s5-qa SKILL.md STEP2). node spawn 불가.
    reads: [".s5-plan.json"],
    produces: ["qa-result.raw.jsonl"],
    successMarker: { files: ["qa-result.raw.jsonl", "qa-result.raw.json"], mode: "any" },
    gate: null,
  },
  {
    id: "s5-finalize", stage: "S5", kind: "stage", terminal: true,
    cmd: (p) => ["skills/s5-qa/run.mjs", "finalize", p],
    reads: ["qa-result.raw.jsonl"],
    produces: ["qa-result.json", "qa-result.md"],
    successMarker: { files: ["qa-result.json"], mode: "all" }, // finalize 는 pass/fail 둘 다 exit0 → passed 는 qa 로 판정
    gate: null,
  },
];

/** 스텝 정의 조회(id). */
export function stepById(id) {
  return STEPS.find((s) => s.id === id);
}
