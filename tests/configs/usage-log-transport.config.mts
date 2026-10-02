import { createCoverageConfig } from "../vitest.base.mts";

export default createCoverageConfig({
  name: "usage-log-transport",
  environment: "happy-dom",
  testFiles: [
    "tests/unit/lib/usage-log-transport.test.ts",
    "src/app/[locale]/dashboard/logs/_components/transport-badge.test.tsx",
    "src/app/[locale]/dashboard/logs/_components/usage-logs-table.test.tsx",
    "src/app/[locale]/dashboard/logs/_components/virtualized-logs-table.test.tsx",
  ],
  sourceFiles: [
    "src/lib/utils/usage-log-transport.ts",
    "src/app/[locale]/dashboard/logs/_components/transport-badge.tsx",
  ],
  thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
});
