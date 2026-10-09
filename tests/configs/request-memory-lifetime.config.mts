import { createCoverageConfig } from "../vitest.base.mts";

export default createCoverageConfig({
  name: "request-memory-lifetime",
  environment: "node",
  testFiles: [
    "tests/unit/proxy/memory-aware-lifetime.test.ts",
    "tests/unit/proxy/memory-aware-response-owner.test.ts",
    "tests/unit/server-response-write-backpressure.test.ts",
    "tests/unit/server-responses-ws-recovery.test.ts",
    "tests/unit/server-responses-ws-memory-lifetime.test.ts",
    "tests/unit/proxy/proxy-handler-public-success.test.ts",
  ],
  sourceFiles: ["src/lib/memory/request-lifetime.ts"],
  thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
});
