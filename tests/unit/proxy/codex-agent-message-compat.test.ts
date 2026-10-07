import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  normalizeCodexAgentMessageResponse,
  prepareCodexAgentMessageRequest,
} from "@/app/v1/_lib/proxy/codex-agent-message-compat";
import type { ProxySession } from "@/app/v1/_lib/proxy/session";

vi.mock("../../../server-lib/responses-ws-limits.js", () => ({
  RESPONSES_WS_MAX_PAYLOAD_BYTES: 4096,
}));

const alias = "cch_collaboration_plaintext";
const encoder = new TextEncoder();

function call(overrides: Record<string, unknown> = {}) {
  return {
    type: "function_call",
    namespace: alias,
    name: "spawn_agent",
    arguments: JSON.stringify({ message: "Read the documentation" }),
    ...overrides,
  };
}

function request(body: Record<string, unknown>, path = "/v1/responses") {
  return {
    requestUrl: new URL(`http://localhost${path}`),
    request: { message: body },
    syncRequestBodyFromMessage: vi.fn().mockResolvedValue(undefined),
  } as unknown as ProxySession;
}

function fragmentedResponse(text: string, size = 1) {
  const bytes = encoder.encode(text);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += size) {
          controller.enqueue(bytes.slice(offset, offset + size));
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } }
  );
}

describe("HTTP Codex agent-message compatibility", () => {
  beforeEach(() => vi.stubEnv("CCH_CODEX_PLAINTEXT_AGENT_MESSAGES", "true"));
  afterEach(() => vi.unstubAllEnvs());

  it("synchronizes raw request bytes for namespace-only replay changes", async () => {
    const session = request({ input: [call({ namespace: "collaboration" })] });
    await prepareCodexAgentMessageRequest(session);
    expect(session.request.message.input).toMatchObject([{ namespace: alias }]);
    expect(session.syncRequestBodyFromMessage).toHaveBeenCalledOnce();
  });

  it("does not reserialize unrelated or already prepared requests", async () => {
    const session = request({ input: [{ type: "compaction", encrypted_content: "gAAAkeep" }] });
    await prepareCodexAgentMessageRequest(session);
    expect(session.syncRequestBodyFromMessage).not.toHaveBeenCalled();
  });

  it.each(["false", "TRUE", ""])('requires the exact opt-in value, not "%s"', async (value) => {
    vi.stubEnv("CCH_CODEX_PLAINTEXT_AGENT_MESSAGES", value);
    const session = request({ input: [call({ namespace: "collaboration" })] });
    await prepareCodexAgentMessageRequest(session);
    expect(session.syncRequestBodyFromMessage).not.toHaveBeenCalled();
    const response = Response.json({ object: "response", output: [call()] });
    expect(normalizeCodexAgentMessageResponse(response)).toBe(response);
  });

  it("leaves non-Responses request endpoints alone", async () => {
    const session = request(
      { input: [call({ namespace: "collaboration" })] },
      "/v1/responses/compact"
    );
    await prepareCodexAgentMessageRequest(session);
    expect(session.syncRequestBodyFromMessage).not.toHaveBeenCalled();
  });

  it.each(["application/json", "Application/Problem+JSON; charset=utf-8"])(
    "normalizes ordinary HTTP %s responses and cleans stale body headers",
    async (contentType) => {
      const response = normalizeCodexAgentMessageResponse(
        new Response(
          JSON.stringify({ object: "response", output: [call(), call({ name: "wait_agent" })] }),
          {
            status: 201,
            statusText: "Created",
            headers: {
              "content-type": contentType,
              "content-length": "999",
              "content-encoding": "identity",
              "transfer-encoding": "chunked",
              "x-request-id": "keep",
            },
          }
        )
      );
      expect(response.status).toBe(201);
      expect(response.statusText).toBe("Created");
      expect(response.headers.get("x-request-id")).toBe("keep");
      for (const header of ["content-length", "content-encoding", "transfer-encoding"]) {
        expect(response.headers.has(header)).toBe(false);
      }
      expect(await response.json()).toMatchObject({
        output: [
          { namespace: "collaboration", encrypted_function_args: [] },
          { namespace: "collaboration", name: "wait_agent" },
        ],
      });
    }
  );

  it.each([
    () => new Response("error", { status: 500 }),
    () => new Response(null, { status: 204 }),
    () => new Response("data", { headers: { "content-type": "text/plain" } }),
    () => new Response(new Uint8Array([1])),
  ])("does not wrap errors, empty bodies, or unrelated formats", (create) => {
    const response = create();
    expect(normalizeCodexAgentMessageResponse(response)).toBe(response);
  });

  it.each([
    "not json",
    "null",
    '{ "object": "response", "output": [] }',
    JSON.stringify({
      object: "response",
      output: [call({ namespace: "collaboration", encrypted_function_args: ["message"] })],
    }),
    JSON.stringify({
      object: "response",
      output: [
        call({ namespace: "collaboration", arguments: JSON.stringify({ message: "gAAAAopaque" }) }),
      ],
    }),
    JSON.stringify({
      object: "response",
      output: [{ type: "reasoning", encrypted_content: "gAAAkeep" }],
    }),
  ])("preserves unchanged JSON bytes: %s", async (text) => {
    const response = new Response(text, { headers: { "content-type": "application/json" } });
    expect(await normalizeCodexAgentMessageResponse(response).text()).toBe(text);
  });

  it.each(["\n", "\r\n", "\r"])(
    "handles fragmented UTF-8 and multiline SSE data with %j line endings",
    async (ending) => {
      const item = call({ arguments: JSON.stringify({ message: "读取文档" }) });
      const event = JSON.stringify({ type: "response.output_item.done", item });
      const split = event.indexOf(',"item"') + 1;
      const frame = [
        ": keepalive",
        "id: frame-1",
        "retry: 1000",
        "event: response.output_item.done",
        `data: ${event.slice(0, split)}`,
        `data:${event.slice(split)}`,
        ": after-data",
        "",
        "",
      ].join(ending);
      const text = await normalizeCodexAgentMessageResponse(fragmentedResponse(frame)).text();
      const normalized = JSON.stringify({
        type: "response.output_item.done",
        item: { ...item, namespace: "collaboration", encrypted_function_args: [] },
      });
      expect(text).toBe(
        [
          ": keepalive",
          "id: frame-1",
          "retry: 1000",
          "event: response.output_item.done",
          `data: ${normalized}`,
          ": after-data",
          "",
          "",
        ].join(ending)
      );
    }
  );

  it.each(["", "\r", "\n"])("rewrites unterminated final SSE frames: %j", async (ending) => {
    const event = { type: "response.completed", response: { output: [call()] } };
    const response = fragmentedResponse(`data: ${JSON.stringify(event)}${ending}`, 7);
    const text = await normalizeCodexAgentMessageResponse(response).text();
    expect(text).toContain('"encrypted_function_args":[]');
    expect(text).not.toContain(alias);
    expect(text.endsWith(ending)).toBe(true);
  });

  it("passes comments, unrelated frames, malformed data and DONE through byte-for-byte", async () => {
    const text =
      ': heartbeat\r\n\r\nevent: response.output_text.delta\ndata: {"delta":"好"}\n\n' +
      "data: not-json\n\ndata: [DONE]\n\n: trailing";
    expect(await normalizeCodexAgentMessageResponse(fragmentedResponse(text, 3)).text()).toBe(text);
  });

  it.each(["\n", "\r\n", "\r"])(
    "delivers %j frames without EOF and propagates cancellation",
    async (ending) => {
      const cancel = vi.fn();
      let source: ReadableStreamDefaultController<Uint8Array>;
      const original = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            source = controller;
          },
          cancel,
        }),
        { headers: { "content-type": "text/event-stream" } }
      );
      const reader = normalizeCodexAgentMessageResponse(original).body!.getReader();
      source!.enqueue(encoder.encode(`: heartbeat${ending}${ending}`));
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(
        `: heartbeat${ending}${ending}`
      );
      await reader.cancel("client disconnected");
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith("client disconnected"));
    }
  );

  it.each(["application/json", "text/event-stream"])(
    "bounds incomplete %s buffering",
    async (type) => {
      const response = new Response("x".repeat(4097), { headers: { "content-type": type } });
      await expect(normalizeCodexAgentMessageResponse(response).text()).rejects.toThrow(
        "4096 characters"
      );
    }
  );

  it("does not drain upstream frames while the downstream reader is backpressured", async () => {
    let pulls = 0;
    const upstream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        },
      },
      { highWaterMark: 0 }
    );
    const response = normalizeCodexAgentMessageResponse(
      new Response(upstream, {
        headers: { "content-type": "text/event-stream" },
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pulls).toBeLessThanOrEqual(1);
    const reader = response.body!.getReader();
    await reader.read();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pulls).toBeLessThanOrEqual(2);
    await reader.cancel();
  });

  it("propagates upstream stream errors", async () => {
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(new Error("upstream failed"));
        },
      }),
      { headers: { "content-type": "text/event-stream" } }
    );
    await expect(normalizeCodexAgentMessageResponse(response).text()).rejects.toThrow(
      "upstream failed"
    );
  });
});
