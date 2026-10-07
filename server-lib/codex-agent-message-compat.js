"use strict";

const MESSAGE_TOOLS = new Set(["spawn_agent", "send_message", "followup_task"]);
const COLLABORATION_TOOLS = new Set([
  ...MESSAGE_TOOLS,
  "wait_agent",
  "interrupt_agent",
  "list_agents",
]);
const UPSTREAM_NAMESPACE = "cch_collaboration_plaintext";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Responses Lite advertises tools inside additional_tools input items; ordinary
// Responses requests advertise them in the top-level tools array.
function prepareCodexPlaintextAgentTools(body) {
  if (!isRecord(body)) return 0;
  const groups = [body.tools];
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (isRecord(item) && item.type === "additional_tools") groups.push(item.tools);
    }
  }
  let changed = 0;
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const namespace of group) {
      if (
        !isRecord(namespace) ||
        namespace.type !== "namespace" ||
        namespace.name !== "collaboration" ||
        !Array.isArray(namespace.tools)
      )
        continue;
      let compatibleNamespace = false;
      for (const tool of namespace.tools) {
        if (!isRecord(tool) || tool.type !== "function" || !MESSAGE_TOOLS.has(tool.name)) continue;
        const message = tool.parameters?.properties?.message;
        if (!isRecord(message) || message.type !== "string") continue;
        compatibleNamespace = true;
        if (message.encrypted === true) {
          delete message.encrypted;
          changed += 1;
        }
      }
      // Some Codex models reserve collaboration.* and reject modified schemas.
      // Use a wire-only alias, then restore it before the client dispatches calls.
      if (compatibleNamespace) namespace.name = UPSTREAM_NAMESPACE;
    }
  }
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (
        isRecord(item) &&
        (item.type === "function_call" || item.type === "function_call_output") &&
        item.namespace === "collaboration" &&
        COLLABORATION_TOOLS.has(item.name)
      ) {
        item.namespace = UPSTREAM_NAMESPACE;
      }
    }
  }
  return changed;
}

function markPlaintextCall(item) {
  if (
    isRecord(item) &&
    item.type === "function_call" &&
    item.namespace === UPSTREAM_NAMESPACE &&
    COLLABORATION_TOOLS.has(item.name)
  ) {
    item.namespace = "collaboration";
  }
  if (
    !isRecord(item) ||
    item.type !== "function_call" ||
    item.namespace !== "collaboration" ||
    !MESSAGE_TOOLS.has(item.name) ||
    item.encrypted_function_args != null
  )
    return;
  let args;
  try {
    args = JSON.parse(item.arguments);
  } catch {
    return;
  }
  if (!isRecord(args) || typeof args.message !== "string") return;
  // Never relabel an opaque envelope as plaintext. Existing encrypted tasks
  // still require an upstream capable of interpreting their payloads.
  if (args.message.trim().startsWith("gAAA")) return;
  // Codex distinguishes an explicit empty list from a missing field. Only []
  // makes collaboration calls use its DirectPlaintextMessage dispatch path.
  item.encrypted_function_args = [];
}

function normalizeCodexPlaintextAgentEvent(event) {
  if (!isRecord(event)) return event;
  if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
    markPlaintextCall(event.item);
  } else if (event.type === "response.completed" && Array.isArray(event.response?.output)) {
    for (const item of event.response.output) markPlaintextCall(item);
  }
  return event;
}

module.exports = { prepareCodexPlaintextAgentTools, normalizeCodexPlaintextAgentEvent };
