import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
const { normalizeResponsesWsRecoveryEvent } = createRequire(import.meta.url)(
  "../../server-lib/responses-ws-recovery.js"
);
describe("Responses WS recovery protocol", () => {
  it.each([502, 503, 504, 524, 429, 408])(
    "turns status %s into a full-context recovery event only for continuations",
    (status) => {
      const event = {
        type: "error",
        status,
        error: { code: "timeout_error", message: "original upstream diagnostic" },
      };
      const normalized = normalizeResponsesWsRecoveryEvent(event, true);
      expect(normalized.error.code).toBe("previous_response_not_found");
      expect(normalized.cch_recovery).toMatchObject({
        original_status: status,
        original_code: "timeout_error",
      });
      expect(normalizeResponsesWsRecoveryEvent(event, false)).toBe(event);
    }
  );
  it.each([400, 401, 403, 413, 422, 499])("preserves a non-retryable status %s", (status) => {
    const event = { type: "error", status, error: { message: "diagnostic" } };
    expect(normalizeResponsesWsRecoveryEvent(event, true)).toBe(event);
  });
  it.each([
    "invalid_api_key",
    "invalid_request_error",
    "context_length_exceeded",
    "content_policy_violation",
    "upstream_ws_message_too_large",
    "local_capacity_exceeded",
    "local_overload",
  ])("preserves %s without inventing a recovery", (code) => {
    const event = { type: "error", error: { code, message: "diagnostic" } };
    expect(normalizeResponsesWsRecoveryEvent(event, true)).toBe(event);
  });
  it("recovers transport error frames and failed responses while preserving successful events", () => {
    for (const event of [
      { type: "error", error: { code: "upstream_ws_closed_mid_stream", message: "socket closed" } },
      {
        type: "response.failed",
        response: { error: { code: "server_error", message: "server unavailable" } },
      },
    ]) {
      expect(normalizeResponsesWsRecoveryEvent(event, true).error.code).toBe(
        "previous_response_not_found"
      );
    }
    for (const event of [
      null,
      {},
      { type: "response.completed" },
      { type: "response.incomplete" },
      { type: "error", error: { code: "previous_response_not_found" } },
    ]) {
      expect(normalizeResponsesWsRecoveryEvent(event, true)).toBe(event);
    }
  });
  it("preserves request error types and recovers errors without a message or code", () => {
    const event = {
      type: "error",
      error: { type: "invalid_request_error", message: "invalid prompt" },
    };
    expect(normalizeResponsesWsRecoveryEvent(event, true)).toBe(event);
    for (const event of [
      { type: "error" },
      { type: "response.failed", response: { error: { code: "server_error" } } },
      { type: "error", error: { status: 503, message: "unavailable" } },
    ]) {
      expect(normalizeResponsesWsRecoveryEvent(event, true).error.code).toBe(
        "previous_response_not_found"
      );
    }
  });
});
