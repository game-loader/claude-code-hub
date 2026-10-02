import { describe, expect, it } from "vitest";
import { getUsageLogTransport } from "@/lib/utils/usage-log-transport";
import type { ProviderChainItem } from "@/types/message";

const entry = (fields: Partial<ProviderChainItem>): ProviderChainItem => ({
  id: 1,
  name: "provider",
  ...fields,
});

describe("usage log upstream transport", () => {
  it.each([null, undefined, []])("does not guess the transport for missing chains: %s", (chain) => {
    expect(getUsageLogTransport(chain)).toBeNull();
  });
  it("leaves undispatched selections and capacity failures unknown", () => {
    expect(getUsageLogTransport([entry({ reason: "initial_selection" })])).toBeNull();
    expect(getUsageLogTransport([entry({ reason: "concurrent_limit_failed" })])).toBeNull();
    expect(
      getUsageLogTransport([
        entry({ reason: "client_error_non_retryable", statusCode: 400, upstreamTransport: null }),
      ])
    ).toBeNull();
  });
  it.each(["websocket", "http"] as const)(
    "uses the terminal attempt's explicit %s metadata",
    (upstreamTransport) => {
      expect(
        getUsageLogTransport([
          entry({ reason: "request_success", statusCode: 200, upstreamTransport }),
        ])
      ).toBe(upstreamTransport);
    }
  );
  it("keeps the HTTP hedge winner when a WS loser is recorded later", () => {
    expect(
      getUsageLogTransport([
        entry({ reason: "responses_ws_attempted", upstreamTransport: "websocket" }),
        entry({ id: 2, reason: "hedge_winner", statusCode: 200, upstreamTransport: "http" }),
        entry({ reason: "hedge_loser_billed", upstreamTransport: "websocket" }),
      ])
    ).toBe("http");
  });
  it("uses the final supplier after WS failure and HTTP failover", () => {
    expect(
      getUsageLogTransport([
        entry({ reason: "responses_ws_attempted" }),
        entry({ reason: "retry_failed", statusCode: 502, upstreamTransport: "websocket" }),
        entry({ id: 2, reason: "retry_success", statusCode: 200, upstreamTransport: "http" }),
      ])
    ).toBe("http");
  });
  it("recognizes legacy WS success and HTTP fallback", () => {
    expect(
      getUsageLogTransport([
        entry({ reason: "responses_ws_attempted" }),
        entry({ reason: "request_success", statusCode: 200 }),
      ])
    ).toBe("websocket");
    expect(
      getUsageLogTransport([
        entry({ reason: "responses_ws_attempted" }),
        entry({ reason: "responses_ws_fallback" }),
        entry({ reason: "request_success", statusCode: 200 }),
      ])
    ).toBe("http");
  });
  it("does not borrow a WS marker from an earlier retry of the same provider", () => {
    expect(
      getUsageLogTransport([
        entry({ reason: "responses_ws_attempted" }),
        entry({ reason: "retry_failed", statusCode: 502, attemptNumber: 1 }),
        entry({ reason: "retry_success", statusCode: 200, attemptNumber: 2 }),
      ])
    ).toBe("http");
  });
  it.each([{ routingAttemptId: "other" }, { attemptNumber: 2 }, { endpointId: 2 }])(
    "does not borrow legacy markers with conflicting attempt identity: %s",
    (identity) => {
      expect(
        getUsageLogTransport([
          entry({ reason: "responses_ws_attempted", ...identity }),
          entry({
            reason: "request_success",
            statusCode: 200,
            routingAttemptId: "winner",
            attemptNumber: 1,
            endpointId: 1,
          }),
        ])
      ).toBe("http");
    }
  );
  it("can identify an active legacy WS request without a terminal status", () => {
    expect(getUsageLogTransport([entry({ reason: "responses_ws_attempted" })])).toBe("websocket");
  });
  it("recognizes ordinary legacy HTTP success", () => {
    expect(getUsageLogTransport([entry({ reason: "request_success", statusCode: 200 })])).toBe(
      "http"
    );
  });
});
