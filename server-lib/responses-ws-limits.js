"use strict";

// CCH's local message ceiling. OpenAI documents 128 MiB for HTTP zstd bodies,
// but does not publish a WebSocket message byte limit.
const RESPONSES_WS_MAX_PAYLOAD_BYTES = 128 * 1024 * 1024;
// Keep room for an in-flight message and one queued message. Pause/resume
// thresholds remain small so ordinary traffic does not fill this budget.
const RESPONSES_WS_MAX_BUFFERED_BYTES = 2 * RESPONSES_WS_MAX_PAYLOAD_BYTES;

function canBufferResponsesWsMessage(messageBytes, bufferedBytes) {
  return (
    messageBytes <= RESPONSES_WS_MAX_PAYLOAD_BYTES &&
    bufferedBytes + messageBytes <= RESPONSES_WS_MAX_BUFFERED_BYTES
  );
}

module.exports = {
  RESPONSES_WS_MAX_PAYLOAD_BYTES,
  RESPONSES_WS_MAX_BUFFERED_BYTES,
  canBufferResponsesWsMessage,
};
