import { createCoverageConfig } from "../vitest.base.mts";

export default createCoverageConfig({
  name: "codex-agent-message-compat",
  environment: "node",
  testFiles: [
    "tests/unit/server-codex-agent-message-compat.test.ts",
    "tests/unit/server-response-write-backpressure.test.ts",
    "tests/unit/server-responses-ws-recovery.test.ts",
  ],
  sourceFiles: ["server-lib/codex-agent-message-compat.js"],
  thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
});
