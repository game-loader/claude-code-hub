import { createCoverageConfig } from "../vitest.base.mts";

export default createCoverageConfig({
  name: "responses-ws-size-limits",
  environment: "node",
  testFiles: [
    "tests/unit/server-responses-ws-limits.test.ts",
    "tests/unit/server-response-write-backpressure.test.ts",
    "tests/unit/server-ws-close-handshake.test.ts",
    "src/app/v1/_lib/responses-ws/__tests__/payload-too-large.test.ts",
    "src/app/v1/_lib/responses-ws/__tests__/upstream-adapter.test.ts",
  ],
  sourceFiles: [
    "server-lib/responses-ws-limits.js",
    "src/app/v1/_lib/responses-ws/payload-too-large.ts",
  ],
  thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
});
