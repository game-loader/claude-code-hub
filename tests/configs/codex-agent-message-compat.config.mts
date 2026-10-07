import { createCoverageConfig } from "../vitest.base.mts";

export default createCoverageConfig({
  name: "codex-agent-message-compat",
  environment: "node",
  testFiles: [
    "tests/unit/server-codex-agent-message-compat.test.ts",
    "tests/unit/server-response-write-backpressure.test.ts",
    "tests/unit/server-responses-ws-recovery.test.ts",
    "tests/unit/proxy/codex-agent-message-compat.test.ts",
    "tests/unit/proxy/proxy-handler-public-success.test.ts",
  ],
  sourceFiles: [
    "server-lib/codex-agent-message-compat.js",
    "src/app/v1/_lib/proxy/codex-agent-message-compat.ts",
  ],
  thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
});
