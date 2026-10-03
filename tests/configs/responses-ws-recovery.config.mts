import { createCoverageConfig } from "../vitest.base.mts";
export default createCoverageConfig({
  name: "responses-ws-recovery",
  environment: "node",
  testFiles: [
    "src/app/v1/_lib/responses-ws/__tests__/recovery-state.test.ts",
    "src/app/v1/_lib/responses-ws/__tests__/recovery-policy.test.ts",
    "tests/unit/server-responses-ws-recovery.test.ts",
    "src/app/v1/_lib/responses-ws/__tests__/continuation-routing.test.ts",
    "src/app/v1/_lib/responses-ws/__tests__/timeout-policy.test.ts",
    "src/app/v1/_lib/responses-ws/__tests__/upstream-adapter.test.ts",
    "tests/unit/proxy/provider-selector-affinity-priority.test.ts",
    "tests/unit/proxy/proxy-forwarder-hedge-first-byte.test.ts",
    "tests/unit/proxy/proxy-forwarder-raw-passthrough-regression.test.ts",
  ],
  sourceFiles: [
    "src/app/v1/_lib/responses-ws/recovery-state.ts",
    "src/app/v1/_lib/responses-ws/recovery-policy.ts",
    "server-lib/responses-ws-recovery.js",
    "src/app/v1/_lib/responses-ws/continuation-routing.ts",
    "src/app/v1/_lib/responses-ws/timeout-policy.ts",
    "src/app/v1/_lib/responses-ws/upstream-adapter.ts",
  ],
  thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
});
