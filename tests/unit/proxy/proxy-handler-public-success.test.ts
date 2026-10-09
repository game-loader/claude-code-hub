import { Context } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProxySession } from "@/app/v1/_lib/proxy/session";
import { attachRequestMemory, getRequestMemoryLifetimeStats } from "@/lib/memory/request-lifetime";
import type { FakeStreamingWhitelistEntry } from "@/types/system-config";
import { MemoryGovernor } from "../../../server-lib/memory-governor";

type ProxySettingsFixture = {
  readonly enableHighConcurrencyMode: boolean;
  readonly allowNonConversationEndpointProviderFallback: boolean;
  readonly enableResponseFixer: boolean;
  readonly enableResponseInputRectifier: boolean;
  readonly fakeStreamingWhitelist: FakeStreamingWhitelistEntry[];
};

const boundary = vi.hoisted(() => ({
  decrementConcurrentCount: vi.fn<(sessionId: string) => Promise<void>>(),
  incrementConcurrentCount: vi.fn<(sessionId: string) => Promise<void>>(),
  loadSettings: vi.fn<() => Promise<ProxySettingsFixture>>(),
  runGuards: vi.fn<(session: ProxySession) => Promise<Response | null>>(),
  send: vi.fn<(session: ProxySession) => Promise<Response>>(),
  fakeStreamingCalls: 0,
}));

let observedSession: ProxySession | null = null;

vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  getCachedSystemSettings: boundary.loadSettings,
}));

vi.mock("@/lib/config/system-settings-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config/system-settings-cache")>()),
  getCachedSystemSettings: boundary.loadSettings,
}));

vi.mock("@/app/v1/_lib/proxy/guard-pipeline", () => ({
  GuardPipelineBuilder: {
    fromSession: () => ({ run: boundary.runGuards }),
  },
}));

vi.mock("@/app/v1/_lib/proxy/forwarder", () => ({
  ProxyForwarder: { send: boundary.send },
}));

vi.mock("@/app/v1/_lib/proxy/fake-streaming/proxy-integration", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/app/v1/_lib/proxy/fake-streaming/proxy-integration")>();

  return {
    ...actual,
    tryFakeStreamingPath: async (
      ...args: Parameters<typeof actual.tryFakeStreamingPath>
    ): Promise<Response | null> => {
      boundary.fakeStreamingCalls += 1;
      return await actual.tryFakeStreamingPath(...args);
    },
  };
});

vi.mock("@/lib/session-tracker", () => ({
  SessionTracker: {
    decrementConcurrentCount: boundary.decrementConcurrentCount,
    incrementConcurrentCount: boundary.incrementConcurrentCount,
    refreshSession: vi.fn(),
  },
}));

vi.mock("@/lib/proxy-status-tracker", () => ({
  ProxyStatusTracker: {
    getInstance: () => ({ endRequest: vi.fn(), startRequest: vi.fn() }),
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  },
}));

import { handleProxyRequest } from "@/app/v1/_lib/proxy-handler";

const defaultSettings: ProxySettingsFixture = {
  enableHighConcurrencyMode: false,
  allowNonConversationEndpointProviderFallback: true,
  enableResponseFixer: true,
  enableResponseInputRectifier: true,
  fakeStreamingWhitelist: [],
};

function createContext(
  pathname: string,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Context {
  const request = new Request(`http://localhost${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  return new Context(request);
}

describe("handleProxyRequest public success behavior", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    observedSession = null;
    boundary.fakeStreamingCalls = 0;
    boundary.runGuards.mockReset();
    boundary.send.mockReset();
    boundary.incrementConcurrentCount.mockReset();
    boundary.decrementConcurrentCount.mockReset();
    boundary.loadSettings.mockReset();
    boundary.loadSettings.mockResolvedValue(defaultSettings);
    boundary.runGuards.mockImplementation(async (session) => {
      observedSession = session;
      return null;
    });
    boundary.incrementConcurrentCount.mockResolvedValue(undefined);
    boundary.decrementConcurrentCount.mockResolvedValue(undefined);
  });

  it("returns a successful upstream response through the real dispatcher", async () => {
    boundary.send.mockResolvedValue(
      new Response(JSON.stringify({ id: "msg_1", type: "message", content: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const response = await handleProxyRequest(
      createContext("/v1/messages", { model: "claude-test", messages: [] })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ id: "msg_1", type: "message", content: [] });
    expect(boundary.send).toHaveBeenCalledOnce();
  });

  it("releases an unconsumed public error response when the client aborts", async () => {
    const memory = new MemoryGovernor({ limit: 100, remote: false, monitor: false, enabled: true });
    const before = getRequestMemoryLifetimeStats();
    const client = new AbortController();
    boundary.send.mockImplementation(async () => {
      attachRequestMemory(memory.tryLease(100)!);
      return Response.json({ error: { message: "Request aborted by client" } }, { status: 499 });
    });
    const response = await handleProxyRequest(
      createContext(
        "/v1/responses",
        {
          model: "local-test",
          input: [],
        },
        client.signal
      )
    );
    client.abort(new Error("client disconnected"));
    await vi.waitFor(() => expect(memory.snapshot().usedBytes).toBe(0));
    expect(getRequestMemoryLifetimeStats().active).toBe(before.active);
    await expect(response.text()).rejects.toThrow("client disconnected");
  });

  it("returns synthesized SSE when the request is fake-stream eligible", async () => {
    boundary.loadSettings.mockResolvedValue({
      ...defaultSettings,
      fakeStreamingWhitelist: [{ model: "gpt-image-2", groupTags: [] }],
    });
    boundary.send.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "msg_fake",
          type: "message",
          role: "assistant",
          model: "claude-test",
          content: [{ type: "text", text: "generated" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 3, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const response = await handleProxyRequest(
      createContext("/v1/messages", { model: "gpt-image-2", messages: [], stream: true })
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(body).toContain("event: message_start");
    expect(body).toContain('"text":"generated"');
    expect(body).toContain("event: message_stop");
    expect(boundary.send).toHaveBeenCalledOnce();
    expect(boundary.fakeStreamingCalls).toBe(1);
  });

  it("normalizes Responses input and output at the public boundary", async () => {
    boundary.send.mockImplementation(
      async (session) =>
        new Response(
          JSON.stringify({
            id: "resp_1",
            object: "response",
            echoed_input: session.request.message.input,
            output: [{ type: "message", content: null }],
            tools: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );

    const response = await handleProxyRequest(
      createContext("/v1/responses", { model: "gpt-5", input: "hello" })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: "resp_1",
      object: "response",
      echoed_input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      output: [{ type: "message", content: [] }],
      tools: [],
    });
  });

  it.each([false, true])("supports direct HTTP agent messages with stream=%s", async (stream) => {
    vi.stubEnv("CCH_CODEX_PLAINTEXT_AGENT_MESSAGES", "true");
    boundary.send.mockImplementation(async (session) => {
      expect(session.request.message.tools).toMatchObject([
        { name: "cch_collaboration_plaintext" },
      ]);
      const wire = JSON.parse(new TextDecoder().decode(session.request.buffer));
      expect(wire.tools[0].tools[0].parameters.properties.message).toEqual({ type: "string" });
      const payload = {
        id: "resp_agent",
        object: "response",
        output: [
          {
            type: "function_call",
            namespace: "cch_collaboration_plaintext",
            name: "spawn_agent",
            arguments: JSON.stringify({ message: "Read README.md" }),
          },
        ],
      };
      return stream
        ? new Response(
            `data: ${JSON.stringify({ type: "response.completed", response: payload })}\n\n`,
            {
              headers: { "content-type": "text/event-stream" },
            }
          )
        : Response.json(payload);
    });
    const response = await handleProxyRequest(
      createContext("/v1/responses", {
        model: "gpt-test",
        stream,
        input: [],
        tools: [
          {
            type: "namespace",
            name: "collaboration",
            tools: [
              {
                type: "function",
                name: "spawn_agent",
                parameters: {
                  type: "object",
                  properties: { message: { type: "string", encrypted: true } },
                },
              },
            ],
          },
        ],
      })
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    const payload = stream ? JSON.parse(text.trim().slice(6)).response : JSON.parse(text);
    expect(payload.output[0]).toMatchObject({
      namespace: "collaboration",
      encrypted_function_args: [],
    });
    expect(boundary.send).toHaveBeenCalledOnce();
  });

  it("routes remote compaction v2 through the v1 compact management policy", async () => {
    boundary.send.mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [{ type: "compaction", encrypted_content: "opaque-state" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const response = await handleProxyRequest(
      createContext("/v1/responses", {
        model: "gpt-5-codex",
        input: [{ role: "user", content: "keep" }, { type: "compaction_trigger" }],
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      output: [{ type: "compaction", encrypted_content: "opaque-state" }],
    });
    expect(observedSession?.getEndpoint()).toBe("/v1/responses");
    expect(observedSession?.getManagedEndpoint()).toBe("/v1/responses/compact");
    expect(observedSession?.getEndpointPolicy().kind).toBe("raw_passthrough");
    expect(boundary.fakeStreamingCalls).toBe(0);
  });

  it("normalizes object-form remote compaction before raw passthrough", async () => {
    boundary.loadSettings.mockResolvedValue({
      ...defaultSettings,
      fakeStreamingWhitelist: [{ model: "gpt-5-codex", groupTags: [] }],
    });
    boundary.send.mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [{ type: "compaction", encrypted_content: "opaque-state" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const response = await handleProxyRequest(
      createContext("/v1/responses", {
        model: "gpt-5-codex",
        stream: true,
        input: { type: "compaction_trigger" },
      })
    );

    expect(response.status).toBe(200);
    expect(observedSession?.getManagedEndpoint()).toBe("/v1/responses/compact");
    expect(observedSession?.getEndpointPolicy().kind).toBe("raw_passthrough");
    expect(observedSession?.request.message.input).toEqual([{ type: "compaction_trigger" }]);
    expect(JSON.parse(new TextDecoder().decode(observedSession?.request.buffer)).input).toEqual([
      { type: "compaction_trigger" },
    ]);
    expect(boundary.fakeStreamingCalls).toBe(0);
    expect(boundary.send).toHaveBeenCalledOnce();
  });
});
