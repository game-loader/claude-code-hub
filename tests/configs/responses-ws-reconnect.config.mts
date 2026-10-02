import { createCoverageConfig } from "../vitest.base.mts";

export default createCoverageConfig({
  name: "responses-ws-reconnect",
  environment: "node",
  testFiles: [
    "src/app/v1/_lib/responses-ws/__tests__/reconnect-policy.test.ts",
    "src/app/v1/_lib/responses-ws/__tests__/eligibility.test.ts",
    "src/app/v1/_lib/responses-ws/__tests__/upstream-adapter.test.ts",
    "tests/unit/proxy/proxy-forwarder-raw-passthrough-regression.test.ts",
  ],
  sourceFiles: [
    "src/app/v1/_lib/responses-ws/reconnect-policy.ts",
    "src/app/v1/_lib/responses-ws/eligibility.ts",
  ],
  thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
});
