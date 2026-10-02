import { describe, expect, it, vi } from "vitest";
const config = vi.hoisted(() => ({ timeout: undefined as number | undefined }));
vi.mock("@/lib/config/env.schema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config/env.schema")>();
  return {
    ...actual,
    getEnvConfig: () => ({ RESPONSES_WS_FIRST_EVENT_TIMEOUT_MS: config.timeout }),
  };
});
import { EnvSchema } from "@/lib/config/env.schema";
import { getResponsesWsFirstEventTimeoutMs } from "../timeout-policy";

describe("Responses WS first-event budget", () => {
  it("defaults to 90 seconds and honors longer provider budgets", () => {
    config.timeout = undefined;
    expect(getResponsesWsFirstEventTimeoutMs()).toBe(90_000);
    expect(getResponsesWsFirstEventTimeoutMs(20_000)).toBe(90_000);
    expect(getResponsesWsFirstEventTimeoutMs(120_000)).toBe(120_000);
  });
  it("accepts an operator-defined budget", () => {
    config.timeout = 60_000;
    expect(getResponsesWsFirstEventTimeoutMs()).toBe(60_000);
    expect(getResponsesWsFirstEventTimeoutMs(75_000)).toBe(75_000);
  });
  it("validates the environment setting and default", () => {
    expect(EnvSchema.parse({}).RESPONSES_WS_FIRST_EVENT_TIMEOUT_MS).toBe(90_000);
    expect(
      EnvSchema.parse({ RESPONSES_WS_FIRST_EVENT_TIMEOUT_MS: "60000" })
        .RESPONSES_WS_FIRST_EVENT_TIMEOUT_MS
    ).toBe(60_000);
    for (const value of [0, -1, 999, 600001, 1500.5, "bad"]) {
      expect(EnvSchema.safeParse({ RESPONSES_WS_FIRST_EVENT_TIMEOUT_MS: value }).success).toBe(
        false
      );
    }
  });
});
