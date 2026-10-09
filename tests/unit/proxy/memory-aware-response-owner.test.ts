// @vitest-environment node
import http from "node:http";
import { Socket } from "node:net";
import { pipeToNodeResponse } from "next/dist/server/pipe-readable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getEnvConfig } from "@/lib/config/env.schema";
import {
  attachRequestMemory,
  getRequestMemoryLifetimeStats,
  onRequestMemoryForcedEnd,
  retainCurrentRequestMemory,
  withRequestMemoryLifetime,
} from "@/lib/memory/request-lifetime";
import { MemoryGovernor } from "../../../server-lib/memory-governor";

vi.mock("@/lib/config/env.schema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config/env.schema")>();
  return { ...actual, getEnvConfig: vi.fn(() => actual.getEnvConfig()) };
});

function governor() {
  return new MemoryGovernor({ limit: 100, remote: false, monitor: false, enabled: true });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("response memory root ownership", () => {
  it("reclaims a body Next skips because its HTTP destination is already destroyed", async () => {
    vi.useFakeTimers();
    const memory = governor();
    const before = getRequestMemoryLifetimeStats();
    const response = await withRequestMemoryLifetime(
      async () => {
        attachRequestMemory(memory.tryLease(100)!);
        return Response.json({ error: { message: "Request aborted by client" } }, { status: 499 });
      },
      { responseIdleTimeoutMs: 1000 }
    );
    const destination = new http.ServerResponse(new http.IncomingMessage(new Socket()));
    destination.destroy();
    await pipeToNodeResponse(response.body!, destination);
    expect(memory.snapshot().usedBytes).toBe(100);
    await vi.advanceTimersByTimeAsync(1001);
    expect(memory.snapshot().usedBytes).toBe(0);
    expect(getRequestMemoryLifetimeStats().active).toBe(before.active);
    await expect(response.text()).rejects.toMatchObject({ name: "TimeoutError" });
  });
  it.each([400, 413, 429, 499, 502])(
    "reclaims an unconsumed %s response without GC",
    async (status) => {
      vi.useFakeTimers();
      const memory = governor();
      const before = getRequestMemoryLifetimeStats();
      const cancel = vi.fn();
      const response = await withRequestMemoryLifetime(
        async () => {
          attachRequestMemory(memory.tryLease(100)!);
          return new Response(new ReadableStream({ cancel }), { status });
        },
        { responseIdleTimeoutMs: 1000 }
      );

      expect(memory.snapshot().usedBytes).toBe(100);
      await vi.advanceTimersByTimeAsync(1001);
      expect(cancel).toHaveBeenCalledOnce();
      expect(cancel.mock.calls[0][0]).toMatchObject({ name: "TimeoutError" });
      expect(memory.snapshot().usedBytes).toBe(0);
      expect(getRequestMemoryLifetimeStats().active).toBe(before.active);
      // Retain the actual Response object: recovery must not depend on GC.
      await expect(response.text()).rejects.toMatchObject({ name: "TimeoutError" });
    }
  );

  it("cancels a hung read and rejects the downstream read on idle expiry", async () => {
    vi.useFakeTimers();
    const memory = governor();
    const cancel = vi.fn();
    const response = await withRequestMemoryLifetime(
      async () => {
        attachRequestMemory(memory.tryLease(100)!);
        return new Response(new ReadableStream({ cancel }));
      },
      { responseIdleTimeoutMs: 1000 }
    );
    const read = response.body!.getReader().read();
    const failed = expect(read).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(1001);
    await failed;
    expect(cancel).toHaveBeenCalledOnce();
    expect(memory.snapshot().usedBytes).toBe(0);
  });

  it("uses the configured idle timeout, clears it at EOF and removes the abort listener", async () => {
    vi.useFakeTimers();
    const memory = governor();
    const client = new AbortController();
    const remove = vi.spyOn(client.signal, "removeEventListener");
    vi.mocked(getEnvConfig).mockReturnValueOnce({
      ...getEnvConfig(),
      REQUEST_MEMORY_RESPONSE_IDLE_TIMEOUT_MS: 2000,
    });
    const cancel = vi.fn();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const response = await withRequestMemoryLifetime(
      async () => {
        attachRequestMemory(memory.tryLease(100)!);
        return new Response(
          new ReadableStream({
            start(controller) {
              source = controller;
            },
            cancel,
          })
        );
      },
      { signal: client.signal }
    );
    await vi.advanceTimersByTimeAsync(1001);
    expect(memory.snapshot().usedBytes).toBe(100);
    source.close();
    await response.text();
    expect(memory.snapshot().usedBytes).toBe(0);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    await vi.advanceTimersByTimeAsync(2001);
    client.abort();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("uses the safe idle default if environment loading fails", async () => {
    vi.useFakeTimers();
    const memory = governor();
    vi.mocked(getEnvConfig).mockImplementationOnce(() => {
      throw new Error("settings unavailable");
    });
    const response = await withRequestMemoryLifetime(async () => {
      attachRequestMemory(memory.tryLease(100)!);
      return new Response(new ReadableStream());
    });
    await vi.advanceTimersByTimeAsync(599_999);
    expect(memory.snapshot().usedBytes).toBe(100);
    await vi.advanceTimersByTimeAsync(2);
    expect(memory.snapshot().usedBytes).toBe(0);
    await expect(response.text()).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it.each(["abort", "cancel", "idle"])(
    "a stuck source %s enters draining and is bounded",
    async (mode) => {
      vi.useFakeTimers();
      const memory = governor();
      const before = getRequestMemoryLifetimeStats();
      const controller = new AbortController();
      const held = Promise.withResolvers<void>();
      const cancel = vi.fn(() => held.promise);
      const disposed = vi.fn();
      const response = await withRequestMemoryLifetime(
        async () => {
          attachRequestMemory(memory.tryLease(100)!);
          onRequestMemoryForcedEnd(disposed);
          return new Response(new ReadableStream({ cancel }));
        },
        { signal: controller.signal, responseIdleTimeoutMs: 1000 }
      );
      let cancellation: Promise<void> | undefined;
      if (mode === "abort") controller.abort(new Error("client disconnected"));
      else if (mode === "cancel") cancellation = response.body!.cancel("client disconnected");
      else await vi.advanceTimersByTimeAsync(1001);
      expect(getRequestMemoryLifetimeStats().drainingLabels["response-source-cancel"]).toBe(1);
      expect(memory.snapshot().usedBytes).toBe(100);
      await vi.advanceTimersByTimeAsync(150_001);
      expect(memory.snapshot().usedBytes).toBe(0);
      expect(disposed).toHaveBeenCalledOnce();
      expect(getRequestMemoryLifetimeStats().active).toBe(before.active);
      expect(getRequestMemoryLifetimeStats().forcedTotal).toBe(before.forcedTotal + 1);
      held.resolve();
      await cancellation;
      expect(cancel).toHaveBeenCalledOnce();
    }
  );

  it("binds abort without any framework read/cancel and preserves real background ownership", async () => {
    const memory = governor();
    const client = new AbortController();
    const remove = vi.spyOn(client.signal, "removeEventListener");
    const cancel = vi.fn();
    let releaseBackground!: () => void;
    const response = await withRequestMemoryLifetime(
      async () => {
        attachRequestMemory(memory.tryLease(100)!);
        releaseBackground = retainCurrentRequestMemory("billing");
        return new Response(new ReadableStream({ cancel }));
      },
      { signal: client.signal }
    );
    const reason = new Error("Request aborted by client");
    client.abort(reason);
    await expect(response.text()).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalledWith(reason);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(memory.snapshot().usedBytes).toBe(100);
    releaseBackground();
    expect(memory.snapshot().usedBytes).toBe(0);
  });

  it.each([false, true])(
    "handles abort before response creation (already aborted=%s)",
    async (already) => {
      vi.useFakeTimers();
      const memory = governor();
      const before = getRequestMemoryLifetimeStats();
      const client = new AbortController();
      const ready = Promise.withResolvers<Response>();
      const cancel = vi.fn();
      const reason = new Error("client aborted before headers");
      if (already) client.abort(reason);
      const result = withRequestMemoryLifetime(
        async () => {
          attachRequestMemory(memory.tryLease(100)!);
          return ready.promise;
        },
        { signal: client.signal }
      );
      if (!already) client.abort(reason);
      expect(getRequestMemoryLifetimeStats().drainingLabels["response-operation"]).toBe(1);
      expect(memory.snapshot().usedBytes).toBe(100);
      ready.resolve(new Response(new ReadableStream({ cancel })));
      const response = await result;
      await expect(response.text()).rejects.toBe(reason);
      await vi.advanceTimersByTimeAsync(0);
      expect(cancel).toHaveBeenCalledWith(reason);
      expect(memory.snapshot().usedBytes).toBe(0);
      expect(getRequestMemoryLifetimeStats().active).toBe(before.active);
    }
  );

  it("bounds an aborted handler which never returns and handles its late failure", async () => {
    vi.useFakeTimers();
    const memory = governor();
    const before = getRequestMemoryLifetimeStats();
    const client = new AbortController();
    const ready = Promise.withResolvers<Response>();
    const disposed = vi.fn();
    const result = withRequestMemoryLifetime(
      async () => {
        attachRequestMemory(memory.tryLease(100)!);
        onRequestMemoryForcedEnd(disposed);
        return ready.promise;
      },
      { signal: client.signal }
    );
    client.abort();
    await vi.advanceTimersByTimeAsync(150_001);
    expect(disposed).toHaveBeenCalledOnce();
    expect(memory.snapshot().usedBytes).toBe(0);
    expect(getRequestMemoryLifetimeStats().active).toBe(before.active);
    ready.reject(new Error("late handler failure"));
    await expect(result).rejects.toThrow("late handler failure");
  });

  it("propagates source cancel rejection but still releases exactly once", async () => {
    const memory = governor();
    const lease = memory.tryLease(100)!;
    const release = vi.spyOn(lease, "release");
    const failure = new Error("source cancel failed");
    const response = await withRequestMemoryLifetime(async () => {
      attachRequestMemory(lease);
      return new Response(new ReadableStream({ cancel: () => Promise.reject(failure) }));
    });
    await expect(response.body!.cancel()).rejects.toBe(failure);
    expect(release).toHaveBeenCalledOnce();
    expect(memory.snapshot().usedBytes).toBe(0);
  });
});
