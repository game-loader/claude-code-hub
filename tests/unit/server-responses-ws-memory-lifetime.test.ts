// @vitest-environment node
import { once } from "node:events";
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  attachRequestMemory,
  getRequestMemoryLifetimeStats,
  withRequestMemoryLifetime,
} from "@/lib/memory/request-lifetime";
import { MemoryGovernor } from "../../server-lib/memory-governor";

const { handleWebSocketConnection } = createRequire(import.meta.url)("../../server.js");
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("real WS to internal HTTP memory ownership", () => {
  it("reclaims repeated error/terminal turns on a persistent socket without EOF or GC", async () => {
    const before = getRequestMemoryLifetimeStats();
    const memory = new MemoryGovernor({ limit: 100, enabled: true, remote: false, monitor: false });
    const tasks = new Set<Promise<void>>();
    let cancellations = 0;
    const internal = http.createServer((req, res) => {
      const abort = new AbortController();
      res.once("close", () => abort.abort(new Error("internal HTTP client closed")));
      const task = (async () => {
        let text = "";
        for await (const chunk of req) text += chunk;
        const input = JSON.parse(text).input;
        const status = typeof input === "number" ? input : 200;
        const response = await withRequestMemoryLifetime(
          async () => {
            const lease = memory.tryLease(100);
            if (!lease) throw new Error("Previous turn leaked its request lease");
            attachRequestMemory(lease);
            return status !== 200
              ? Response.json(
                  { error: { code: "rejected", message: "diagnostic error" } },
                  { status }
                )
              : new Response(
                  new ReadableStream<Uint8Array>({
                    start(controller) {
                      controller.enqueue(
                        new TextEncoder().encode(`data: ${JSON.stringify({ type: input })}\n\n`)
                      );
                      // Deliberately never emit EOF: WS terminal must destroy HTTP.
                    },
                    cancel() {
                      cancellations++;
                    },
                  }),
                  { headers: { "content-type": "text/event-stream" } }
                );
          },
          { signal: abort.signal, responseIdleTimeoutMs: 60_000 }
        );
        res.writeHead(response.status, Object.fromEntries(response.headers));
        await pipeline(Readable.fromWeb(response.body!), res);
      })().catch(() => {
        res.destroy();
      });
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
    });
    internal.listen(0, "127.0.0.1");
    await once(internal, "listening");
    cleanups.push(async () => {
      internal.closeAllConnections();
      await new Promise<void>((resolve) => internal.close(() => resolve()));
      await Promise.allSettled(tasks);
    });
    const edge = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    edge.on("connection", (socket, req) => {
      void handleWebSocketConnection(socket, req, {
        hostname: "127.0.0.1",
        port: (internal.address() as AddressInfo).port,
      });
    });
    await once(edge, "listening");
    cleanups.push(async () => {
      for (const client of edge.clients) client.terminate();
      await new Promise<void>((resolve) => edge.close(() => resolve()));
    });
    const client = new WebSocket(
      `ws://127.0.0.1:${(edge.address() as AddressInfo).port}/v1/responses`
    );
    await once(client, "open");
    cleanups.push(async () => {
      client.terminate();
    });
    for (let round = 0; round < 3; round++) {
      for (const input of [
        400,
        413,
        429,
        499,
        502,
        "error",
        "response.failed",
        "response.completed",
      ]) {
        const frame = once(client, "message");
        client.send(JSON.stringify({ type: "response.create", model: "local-test", input }));
        const [data] = await frame;
        const event = JSON.parse(data.toString());
        expect(event.type).toBe(typeof input === "number" ? "error" : input);
        if (typeof input === "number") expect(event.status).toBe(input);
        await expect.poll(() => memory.snapshot().usedBytes).toBe(0);
        await expect.poll(() => getRequestMemoryLifetimeStats().active).toBe(before.active);
        expect(getRequestMemoryLifetimeStats().draining).toBe(before.draining);
      }
    }
    expect(cancellations).toBe(9);
    expect(getRequestMemoryLifetimeStats().forcedTotal).toBe(before.forcedTotal);
    expect(client.readyState).toBe(WebSocket.OPEN);
  });
});
