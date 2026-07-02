// s4-build · LLM 출력 정리 — 공용 lib/clean.mjs 재export(코드용 cleanCodeOutput = 기존 cleanFileOutput).
//   산문 프리앰블/꼬리말·주입 방어 로직은 poc-forge 전 스테이지가 lib/clean.mjs 하나를 공유한다.
export { cleanCodeOutput as cleanFileOutput, cleanMarkdownDoc, extractJson } from "../../lib/clean.mjs";
