import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProxySession } from "../../proxy/session";
import {
  captureResponsesContinuationOwner,
  clearResponsesContinuationOwnersForTests,
  getResponsesContinuationOwner,
  rememberResponsesContinuationOwner,
  responsesProviderCredentialFingerprint,
  type ResponsesContinuationOwner,
} from "../response-ownership";

const redis = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/redis/client", () => ({ getRedisClient: () => redis.client }));
const owner: ResponsesContinuationOwner = {
  providerId: 647,
  endpointId: 22,
  baseUrl: "https://opai.example/v1",
  transport: "http",
};
function session(keyId = 5): ProxySession {
  return {
    authState: { key: { id: keyId } },
    provider: { providerType: "codex" },
    originalFormat: "response",
    requestUrl: new URL("https://cch.example/v1/responses"),
    request: { message: { model: "gpt-test", stream: true } },
    getEndpoint: () => "/v1/responses",
  } as unknown as ProxySession;
}
function json(id = "resp_owned", extra = {}) {
  return { object: "response", id, status: "completed", output: [], ...extra };
}
function sse(payload: unknown, ending = "\n") {
  return `event: response.completed${ending}data: ${JSON.stringify(payload)}${ending}${ending}`;
}
function fragmented(text: string, contentType = "text/event-stream", size = 1) {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
        controller.close();
      },
    }),
    { headers: { "content-type": contentType } }
  );
}
beforeEach(() => {
  clearResponsesContinuationOwnersForTests();
  redis.client = null;
});
afterEach(() => vi.useRealTimers());

describe("Responses reply ownership", () => {
  it("isolates API keys while surviving client thread and socket changes", async () => {
    const first = session();
    await rememberResponsesContinuationOwner(first, "resp_owned", owner);
    expect(await getResponsesContinuationOwner(session(), "resp_owned")).toEqual(owner);
    expect(await getResponsesContinuationOwner(session(6), "resp_owned")).toBeNull();
    expect(await getResponsesContinuationOwner(session(), "unknown")).toBeNull();
    first.authState = null;
    expect(await getResponsesContinuationOwner(first, "resp_owned")).toBeNull();
  });
  it("shares the exact endpoint and transport across worker-local cache resets", async () => {
    const records = new Map<string, string>();
    redis.client = {
      status: "ready",
      setex: vi.fn(async (key, _ttl, value) => {
        records.set(key, value);
      }),
      get: vi.fn(async (key) => records.get(key)),
    };
    await rememberResponsesContinuationOwner(session(), "resp_owned", owner);
    clearResponsesContinuationOwnersForTests();
    expect(await getResponsesContinuationOwner(session(), "resp_owned")).toEqual(owner);
    expect([...records.keys()][0]).not.toContain("resp_owned");
  });
  it("uses shared ownership rather than a stale local provider", async () => {
    let record = "";
    redis.client = {
      status: "ready",
      setex: vi.fn(async (_key, _ttl, value) => {
        record = value;
      }),
      get: vi.fn(async () => record),
    };
    await rememberResponsesContinuationOwner(session(), "resp_owned", owner);
    record = JSON.stringify({ ...owner, providerId: 727, expiresAt: Date.now() + 60_000 });
    expect(await getResponsesContinuationOwner(session(), "resp_owned")).toMatchObject({
      providerId: 727,
    });
  });
  it.each([
    null,
    "not-json",
    JSON.stringify({ ...owner, baseUrl: "file:///etc/passwd", expiresAt: Date.now() + 60_000 }),
  ])("tolerates malformed shared ownership: %s", async (record) => {
    await rememberResponsesContinuationOwner(session(), "resp_owned", owner);
    redis.client = { status: "ready", get: vi.fn(async () => record) };
    expect(await getResponsesContinuationOwner(session(), "resp_owned")).toEqual(owner);
  });
  it("expires local and shared records", async () => {
    vi.useFakeTimers();
    await rememberResponsesContinuationOwner(session(), "resp_owned", owner);
    await vi.advanceTimersByTimeAsync(3_600_001);
    expect(await getResponsesContinuationOwner(session(), "resp_owned")).toBeNull();
    redis.client = {
      status: "ready",
      get: vi.fn(async () => JSON.stringify({ ...owner, expiresAt: Date.now() - 1 })),
    };
    expect(await getResponsesContinuationOwner(session(), "resp_owned")).toBeNull();
  });
  it("bounds unavailable Redis latency while preserving local records", async () => {
    vi.useFakeTimers();
    redis.client = {
      status: "ready",
      setex: vi.fn(() => new Promise(() => {})),
      get: vi.fn(() => new Promise(() => {})),
    };
    const write = rememberResponsesContinuationOwner(session(), "resp_owned", owner);
    await vi.advanceTimersByTimeAsync(251);
    await write;
    const read = getResponsesContinuationOwner(session(), "resp_owned");
    await vi.advanceTimersByTimeAsync(251);
    expect(await read).toEqual(owner);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["", "x".repeat(257), "bad\nid", "bad\u0000id"])(
    "rejects unsafe or oversized IDs: %s",
    async (id) => {
      await rememberResponsesContinuationOwner(session(), id, owner);
      expect(await getResponsesContinuationOwner(session(), id)).toBeNull();
    }
  );
  it.each([
    { providerId: 0 },
    { endpointId: -1 },
    { baseUrl: "invalid-url" },
    { transport: "ftp" },
    { credentialFingerprint: "not-a-hash" },
  ])("rejects invalid routes: %j", async (invalid) => {
    await rememberResponsesContinuationOwner(session(), "resp_owned", {
      ...owner,
      ...invalid,
    } as ResponsesContinuationOwner);
    expect(await getResponsesContinuationOwner(session(), "resp_owned")).toBeNull();
  });
  it("bounds the process-local cache", async () => {
    for (let i = 0; i < 16_385; i++)
      await rememberResponsesContinuationOwner(session(), `resp_${i}`, owner);
    expect(await getResponsesContinuationOwner(session(), "resp_0")).toBeNull();
    expect(await getResponsesContinuationOwner(session(), "resp_16384")).toEqual(owner);
  });
  it("fingerprints upstream credentials without storing them", () => {
    const fingerprint = responsesProviderCredentialFingerprint({ key: "test-upstream-secret" });
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint).not.toBe(responsesProviderCredentialFingerprint({ key: "changed" }));
  });
  it("treats compatible upstream IDs as opaque strings, not URL or Redis paths", async () => {
    for (const id of ["resp_encoded+/==", "../opaque?id=value", "回复标识"]) {
      await captureResponsesContinuationOwner(session(), Response.json(json(id)), owner).text();
      expect(await getResponsesContinuationOwner(session(), id)).toEqual(owner);
    }
  });
  it("captures an ordinary HTTP JSON response without changing its bytes", async () => {
    const text = JSON.stringify(json());
    const result = captureResponsesContinuationOwner(
      session(),
      new Response(text, {
        headers: { "content-type": "application/json", "x-request-id": "keep" },
      }),
      owner
    );
    expect(await result.text()).toBe(text);
    expect(result.headers.get("x-request-id")).toBe("keep");
    expect(await getResponsesContinuationOwner(session(), "resp_owned")).toEqual(owner);
  });
  it.each(["\n", "\r\n", "\r"])(
    "captures fragmented SSE with %j endings and UTF-8",
    async (ending) => {
      const text = sse(
        {
          type: "response.completed",
          response: json("resp_owned", { output: [{ text: "你好" }] }),
        },
        ending
      );
      expect(
        await captureResponsesContinuationOwner(session(), fragmented(text), owner).text()
      ).toBe(text);
      expect(await getResponsesContinuationOwner(session(), "resp_owned")).toEqual(owner);
    }
  );
  it("observes multiline and unterminated final frames", async () => {
    const text =
      'data: {"type":"response.completed",\n' +
      'data: "response":{"id":"resp_owned","status":"completed"}}';
    expect(await captureResponsesContinuationOwner(session(), fragmented(text), owner).text()).toBe(
      text
    );
    expect(await getResponsesContinuationOwner(session(), "resp_owned")).toEqual(owner);
  });
  it("persists before delivering the terminal chunk, without waiting for HTTP EOF", async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(
      new ReadableStream({
        start(controller) {
          source = controller;
        },
      }),
      { headers: { "content-type": "text/event-stream" } }
    );
    const result = captureResponsesContinuationOwner(session(), response, owner);
    source.enqueue(new TextEncoder().encode(sse({ type: "response.completed", response: json() })));
    const reader = result.body!.getReader();
    await reader.read();
    expect(await getResponsesContinuationOwner(session(), "resp_owned")).toEqual(owner);
    await reader.cancel();
  });
  it("does not materialize large compaction/reasoning payloads before reading a trailing ID", async () => {
    const text = sse({
      type: "response.completed",
      response: {
        output: [{ type: "compaction", encrypted_content: "x".repeat(2 * 1024 * 1024) }],
        id: "resp_owned",
        status: "completed",
      },
    });
    const result = captureResponsesContinuationOwner(
      session(),
      fragmented(text, "text/event-stream", 4096),
      owner
    );
    expect(await result.text()).toBe(text);
    expect(await getResponsesContinuationOwner(session(), "resp_owned")).toEqual(owner);
  });
  it("accepts a 256-character reply ID without truncation", async () => {
    const id = `resp_${"x".repeat(251)}`;
    await captureResponsesContinuationOwner(session(), Response.json(json(id)), owner).text();
    expect(await getResponsesContinuationOwner(session(), id)).toEqual(owner);
  });
  it.each([
    json("resp_owned", { status: "failed" }),
    json("resp_owned", { error: { message: "failed" } }),
    { type: "response.created", response: json() },
    { type: "response.failed", response: json() },
    { object: "message", id: "resp_owned" },
    { object: "response", id: "bad\nid" },
  ])("does not bind failed or unrelated response payloads: %j", async (payload) => {
    await captureResponsesContinuationOwner(session(), Response.json(payload), owner).text();
    expect(await getResponsesContinuationOwner(session(), "resp_owned")).toBeNull();
  });
  it("preserves duplicate-key JSON semantics and malformed data", async () => {
    for (const text of [
      '{"object":"response","id":"resp_owned","id":null}',
      '{"type":"response.completed","type":"error","response":{"id":"resp_owned"}}',
      "malformed",
      "null",
    ]) {
      expect(
        await captureResponsesContinuationOwner(
          session(),
          new Response(text, { headers: { "content-type": "application/json" } }),
          owner
        ).text()
      ).toBe(text);
    }
    expect(await getResponsesContinuationOwner(session(), "resp_owned")).toBeNull();
  });
  it("captures a Codex SSE stream with a missing media type", async () => {
    const text = sse({ type: "response.completed", response: json() });
    await captureResponsesContinuationOwner(
      session(),
      fragmented(text, "application/octet-stream"),
      owner
    ).text();
    expect(await getResponsesContinuationOwner(session(), "resp_owned")).toEqual(owner);
  });
  it.each(["endpoint", "auth", "status", "no-body", "html"])(
    "does not wrap unrelated %s responses",
    (kind) => {
      const request = session();
      if (kind === "endpoint")
        request.requestUrl = new URL("https://cch.example/v1/responses/compact");
      if (kind === "auth") request.authState = null;
      const response =
        kind === "no-body"
          ? new Response(null)
          : new Response("body", {
              status: kind === "status" ? 400 : 200,
              headers: { "content-type": kind === "html" ? "text/html" : "application/json" },
            });
      expect(captureResponsesContinuationOwner(request, response, owner)).toBe(response);
    }
  );
});
