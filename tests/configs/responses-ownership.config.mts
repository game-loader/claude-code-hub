import { createCoverageConfig } from "../vitest.base.mts";
export default createCoverageConfig({
  name: "responses-ownership",
  environment: "node",
  testFiles: [
    "src/app/v1/_lib/responses-ws/__tests__/response-ownership.test.ts",
    "tests/unit/proxy/provider-selector-affinity-priority.test.ts",
    "tests/unit/proxy/proxy-forwarder-raw-passthrough-regression.test.ts",
    "tests/unit/proxy/proxy-forwarder-hedge-first-byte.test.ts",
  ],
  sourceFiles: ["src/app/v1/_lib/responses-ws/response-ownership.ts"],
  thresholds: { lines: 80, statements: 80, branches: 80, functions: 80 },
});
