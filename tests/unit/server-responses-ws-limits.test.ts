import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const {
  RESPONSES_WS_MAX_PAYLOAD_BYTES,
  RESPONSES_WS_MAX_BUFFERED_BYTES,
  canBufferResponsesWsMessage,
} = createRequire(import.meta.url)("../../server-lib/responses-ws-limits.js");

describe("Responses WebSocket message and queue limits", () => {
  it("admits one 128 MiB message and leaves room for the next message", () => {
    expect(canBufferResponsesWsMessage(128 * 1024 * 1024, 0)).toBe(true);
    expect(canBufferResponsesWsMessage(128 * 1024 * 1024, 128 * 1024 * 1024)).toBe(true);
  });

  it("rejects an oversized message even when the queue is empty", () => {
    expect(canBufferResponsesWsMessage(RESPONSES_WS_MAX_PAYLOAD_BYTES + 1, 0)).toBe(false);
  });

  it("rejects queue overflow while accepting the exact byte boundary", () => {
    expect(canBufferResponsesWsMessage(1, RESPONSES_WS_MAX_BUFFERED_BYTES - 1)).toBe(true);
    expect(canBufferResponsesWsMessage(1, RESPONSES_WS_MAX_BUFFERED_BYTES)).toBe(false);
  });
});
