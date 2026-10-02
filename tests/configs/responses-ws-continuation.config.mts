import { createCoverageConfig } from "../vitest.base.mts";

export default createCoverageConfig({
  name: "responses-ws-continuation",
  environment: "node",
  testFiles: [
    "src/app/v1/_lib/responses-ws/__tests__/continuation.test.ts",
    "src/app/v1/_lib/responses-ws/__tests__/upstream-adapter.test.ts",
    "tests/unit/proxy/proxy-forwarder-raw-passthrough-regression.test.ts",
    "tests/unit/proxy/error-handler-terminal-status.test.ts",
  ],
  sourceFiles: ["src/app/v1/_lib/responses-ws/continuation.ts"],
  thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
});
