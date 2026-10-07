import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const { prepareCodexPlaintextAgentTools, normalizeCodexPlaintextAgentEvent } = createRequire(
  import.meta.url
)("../../server-lib/codex-agent-message-compat.js");

function namespace(name = "collaboration") {
  return {
    type: "namespace",
    name,
    tools: ["spawn_agent", "send_message", "followup_task"].map((name) => ({
      type: "function",
      name,
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", encrypted: true },
          secret: { type: "string", encrypted: true },
        },
      },
    })),
  };
}

function call(overrides: Record<string, unknown> = {}) {
  return {
    type: "function_call",
    namespace: "collaboration",
    name: "spawn_agent",
    arguments: JSON.stringify({ task_name: "probe", message: "Read README.md" }),
    ...overrides,
  };
}

describe("Codex plaintext agent-message compatibility", () => {
  it.each(["tools", "additional_tools"])(
    "rewrites only collaboration message schemas in %s",
    (location) => {
      const group = namespace();
      const opaque = { type: "reasoning", encrypted_content: "gAAAA-preserve" };
      const body =
        location === "tools"
          ? { tools: [group], input: [opaque] }
          : { input: [opaque, { type: "additional_tools", tools: [group] }] };
      expect(prepareCodexPlaintextAgentTools(body)).toBe(3);
      expect(group.name).toBe("cch_collaboration_plaintext");
      for (const tool of group.tools) {
        expect(tool.parameters.properties.message.encrypted).toBeUndefined();
        expect(tool.parameters.properties.secret.encrypted).toBe(true);
      }
      expect(opaque.encrypted_content).toBe("gAAAA-preserve");
      expect(prepareCodexPlaintextAgentTools(body)).toBe(0);
    }
  );

  it.each([
    null,
    [],
    {},
    { tools: {} },
    { tools: [null, "invalid", namespace("custom")] },
    { input: [null, { type: "message", tools: [namespace()] }] },
    { input: [{ type: "additional_tools", tools: null }] },
    { tools: [{ type: "namespace", name: "collaboration", tools: null }] },
    {
      tools: [
        {
          type: "namespace",
          name: "collaboration",
          tools: [null, { type: "function", name: "other" }],
        },
      ],
    },
    {
      tools: [
        {
          type: "namespace",
          name: "collaboration",
          tools: [{ type: "function", name: "spawn_agent" }],
        },
      ],
    },
  ])("ignores unrelated or malformed tool declarations: %j", (body) => {
    const original = structuredClone(body);
    expect(prepareCodexPlaintextAgentTools(body)).toBe(0);
    expect(body).toEqual(original);
  });

  it("uses the same upstream alias for replayed calls and their outputs", () => {
    const body = {
      input: [
        call(),
        {
          type: "function_call_output",
          namespace: "collaboration",
          name: "wait_agent",
          output: "done",
        },
        call({ namespace: "custom" }),
        { type: "agent_message", namespace: "collaboration", name: "spawn_agent" },
      ],
    };
    prepareCodexPlaintextAgentTools(body);
    expect(body.input.map((item) => item.namespace)).toEqual([
      "cch_collaboration_plaintext",
      "cch_collaboration_plaintext",
      "custom",
      "collaboration",
    ]);
  });

  it.each([
    "spawn_agent",
    "send_message",
    "followup_task",
    "wait_agent",
    "interrupt_agent",
    "list_agents",
  ])("restores the client namespace for %s", (name) => {
    const item = call({ namespace: "cch_collaboration_plaintext", name });
    normalizeCodexPlaintextAgentEvent({ type: "response.output_item.done", item });
    expect(item.namespace).toBe("collaboration");
    expect(item).toMatchObject(
      ["spawn_agent", "send_message", "followup_task"].includes(name)
        ? { encrypted_function_args: [] }
        : { name }
    );
  });

  it("restores the namespace without relabeling encrypted upstream arguments", () => {
    const item = call({
      namespace: "cch_collaboration_plaintext",
      arguments: JSON.stringify({ message: "gAAAAopaque" }),
    });
    normalizeCodexPlaintextAgentEvent({ type: "response.output_item.done", item });
    expect(item.namespace).toBe("collaboration");
    expect(item).not.toHaveProperty("encrypted_function_args");
  });

  it.each(["response.output_item.added", "response.output_item.done", "response.completed"])(
    "marks plaintext function calls in %s",
    (type) => {
      const item = call();
      const event =
        type === "response.completed" ? { type, response: { output: [item] } } : { type, item };
      normalizeCodexPlaintextAgentEvent(event);
      expect(item).toMatchObject({ encrypted_function_args: [] });
      expect(JSON.parse(item.arguments).message).toBe("Read README.md");
    }
  );

  it.each([
    { type: "message" },
    { namespace: "custom" },
    { name: "other" },
    { arguments: "not-json" },
    { arguments: "null" },
    { arguments: "{}" },
    { arguments: JSON.stringify({ message: 3 }) },
    { arguments: JSON.stringify({ message: "gAAAAABsynthetic-opaque-state" }) },
    { encrypted_function_args: ["message"] },
    { encrypted_function_args: [] },
    { encrypted_function_args: "invalid" },
  ])("preserves ciphertext and explicit argument metadata: %j", (overrides) => {
    const item = call(overrides);
    const original = structuredClone(item);
    normalizeCodexPlaintextAgentEvent({ type: "response.output_item.done", item });
    expect(item).toEqual(original);
  });

  it.each([null, [], {}, { type: "error" }, { type: "response.completed", response: null }])(
    "passes unrelated events through: %j",
    (event) => {
      expect(normalizeCodexPlaintextAgentEvent(event)).toBe(event);
    }
  );

  it("does not reinterpret reasoning, compaction or agent-message content", () => {
    const event = {
      type: "response.completed",
      response: {
        output: [
          { type: "reasoning", encrypted_content: "gAAAAreasoning" },
          { type: "compaction", encrypted_content: "gAAAAcompaction" },
          {
            type: "agent_message",
            content: [{ type: "encrypted_content", encrypted_content: "gAAAAtask" }],
          },
        ],
      },
    };
    const original = structuredClone(event);
    normalizeCodexPlaintextAgentEvent(event);
    expect(event).toEqual(original);
  });
});
