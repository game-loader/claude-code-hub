import { describe, expect, it } from "vitest";
import { shouldReconnectResponsesWs } from "../reconnect-policy";
import type { UpstreamWsFailure } from "../upstream-adapter";

const failure = (fields: Partial<UpstreamWsFailure>): UpstreamWsFailure => ({
  failed: true,
  reason: "ws_error_pre_first_event",
  cacheableAsUnsupported: false,
  ...fields,
});

describe("Responses WS reconnect policy", () => {
  it.each([undefined, "ECONNRESET", "ECONNREFUSED", "TLS connection closed"])(
    "reconnects a transient failure without a response event: %s",
    (message) => {
      expect(shouldReconnectResponsesWs(failure({ message }))).toBe(true);
    }
  );
  it("reconnects a socket that closed without any event", () => {
    expect(shouldReconnectResponsesWs(failure({ reason: "ws_closed_before_first_event" }))).toBe(
      true
    );
  });
  it.each([500, 502, 503, 504])("reconnects a temporary HTTP %s handshake failure", (status) => {
    expect(
      shouldReconnectResponsesWs(
        failure({ reason: "ws_upgrade_rejected", message: `HTTP ${status} Unavailable` })
      )
    ).toBe(true);
  });
  it.each([
    "ws_module_unavailable",
    "ws_payload_too_large",
    "ws_continuation_unavailable",
  ] as const)("does not retry a request that cannot be recovered by reconnecting: %s", (reason) => {
    expect(shouldReconnectResponsesWs(failure({ reason }))).toBe(false);
  });
  it.each([400, 401, 403, 404, 405, 426, 429, 501])(
    "does not retry HTTP %s handshake rejection immediately",
    (status) => {
      expect(
        shouldReconnectResponsesWs(
          failure({ reason: "ws_upgrade_rejected", message: `HTTP ${status} Rejected` })
        )
      ).toBe(false);
    }
  );
  it("does not retry invalid WS URL/configuration failures", () => {
    expect(
      shouldReconnectResponsesWs(failure({ reason: "ws_upgrade_rejected", message: "Invalid URL" }))
    ).toBe(false);
    expect(shouldReconnectResponsesWs(failure({ reason: "ws_upgrade_rejected" }))).toBe(false);
  });
  it.each([
    "timeout_waiting_for_first_event",
    "ETIMEDOUT",
    "headers timed out",
    "upstream payload exceeded 8388608 bytes",
    "Payload too large",
    "aborted before first event",
  ])("avoids repeating slow or deterministic failures: %s", (message) => {
    expect(shouldReconnectResponsesWs(failure({ message }))).toBe(false);
  });
  it("does not retry a confirmed protocol rejection", () => {
    expect(shouldReconnectResponsesWs(failure({ cacheableAsUnsupported: true }))).toBe(false);
  });
});
