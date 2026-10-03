"use strict";

// Keep request/authentication errors intact; only recover transport/provider failures.
const CLIENT_ERROR_CODE =
  /invalid|unauthor|forbidden|authentication|context_length|content_policy|payload|too_large|too_big|permission|unsupported|account_deactivated|local_capacity|local_overload/i;

function normalizeResponsesWsRecoveryEvent(event, continuation) {
  if (!continuation || !event || typeof event !== "object") return event;
  if (event.type !== "error" && event.type !== "response.failed") return event;
  const error = event.error || event.response?.error || {};
  const code = typeof error.code === "string" ? error.code : "";
  if (code === "previous_response_not_found" || CLIENT_ERROR_CODE.test(code)) return event;
  if (CLIENT_ERROR_CODE.test(typeof error.type === "string" ? error.type : "")) return event;
  const status = Number(event.status ?? error.status ?? event.cch_recovery?.original_status);
  if (Number.isFinite(status) && status >= 400 && status < 500 && ![408, 429].includes(status)) {
    return event;
  }
  return {
    type: "error",
    status: 400,
    error: {
      type: "invalid_request_error",
      code: "previous_response_not_found",
      param: "previous_response_id",
      // Preserve the original diagnostic; the recovery code is the client contract.
      message: typeof error.message === "string" ? error.message : code,
    },
    cch_recovery: {
      original_status: Number.isFinite(status) && status >= 400 ? status : 502,
      original_code: code || event.type,
    },
  };
}

module.exports = { normalizeResponsesWsRecoveryEvent };
