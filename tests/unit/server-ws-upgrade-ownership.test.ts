import { once } from "node:events";
import http from "node:http";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

const requireFromHere = createRequire(import.meta.url);
const nextPath = requireFromHere.resolve("next");
const nextFactory = requireFromHere(nextPath);
const nextModule = requireFromHere.cache[nextPath]!;
const serverPath = requireFromHere.resolve("../../server.js");
const servers: http.Server[] = [];
const clients: WebSocket[] = [];
const intervals: ReturnType<typeof setInterval>[] = [];
const signalListeners = new Map(
  ["SIGTERM", "SIGINT"].map((signal) => [signal, new Set(process.listeners(signal))])
);

type RequestBody = { input: string; previous_response_id?: string; stream: boolean };

afterEach(async () => {
  for (const ws of clients) ws.terminate();
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        })
    )
  );
  for (const interval of intervals) clearInterval(interval);
  for (const [signal, original] of signalListeners) {
    for (const listener of process.listeners(signal)) {
      if (!original.has(listener)) process.removeListener(signal, listener);
    }
  }
  servers.length = 0;
  clients.length = 0;
  intervals.length = 0;
  nextModule.exports = nextFactory;
  delete requireFromHere.cache[serverPath];
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function startServer(nodeEnv: string) {
  vi.stubEnv("PORT", "0");
  vi.stubEnv("HOSTNAME", "127.0.0.1");
  vi.stubEnv("NODE_ENV", nodeEnv);
  vi.stubEnv("CCH_MULTICORE_BACKGROUND_OWNER", "0");
  vi.stubEnv("CCH_RESPONSES_WS_INTERNAL_SECRET", undefined);
  vi.stubEnv("__NEXT_PRIVATE_STANDALONE_CONFIG", undefined);

  const createServer = http.createServer;
  vi.spyOn(http, "createServer").mockImplementation((...args) => {
    const server = createServer(...args);
    servers.push(server);
    return server;
  });
  const startInterval = globalThis.setInterval;
  vi.spyOn(globalThis, "setInterval").mockImplementation((...args) => {
    const interval = startInterval(...args);
    intervals.push(interval);
    return interval;
  });

  const bodies: RequestBody[] = [];
  const nextUpgrades = vi.fn((_req: http.IncomingMessage, socket: import("node:net").Socket) => {
    // Next's router ends upgrades targeting App routes. Keep that failure mode
    // while exercising the real factory and lazy setupWebSocketHandler below.
    socket.end();
  });
  nextModule.exports = (options: Parameters<typeof nextFactory>[0]) => {
    const app = nextFactory(options);
    app.prepare = async () => {};
    app.init = {
      upgradeHandler: nextUpgrades,
      requestHandler: async (req: http.IncomingMessage, res: http.ServerResponse) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        if (req.method !== "POST") {
          res.end("http-ok");
          return;
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RequestBody;
        bodies.push(body);
        const id = `response_${bodies.length}`;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ type: "response.created", response: { id } })}\n\n`);
        res.end(`data: ${JSON.stringify({ type: "response.completed", response: { id } })}\n\n`);
      },
    };
    return app;
  };

  delete requireFromHere.cache[serverPath];
  await requireFromHere(serverPath).main();
  expect(servers).toHaveLength(2);
  const [internalServer, publicServer] = servers;
  const address = publicServer.address() as import("node:net").AddressInfo;
  const internalAddress = internalServer.address() as import("node:net").AddressInfo;
  expect(internalAddress.address).toBe("127.0.0.1");
  expect(internalAddress.port).not.toBe(address.port);
  return { internalServer, publicServer, bodies, nextUpgrades, port: address.port };
}

async function getHttp(port: number) {
  return new Promise<string>((resolve, reject) => {
    http
      .get({ hostname: "127.0.0.1", port, path: "/v1/responses" }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

async function connectWs(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/responses`);
  clients.push(ws);
  const events: Array<{ type: string; response: { id: string } }> = [];
  const closed = once(ws, "close");
  ws.on("message", (raw) => events.push(JSON.parse(raw.toString())));
  await once(ws, "open");
  return { ws, events, closed };
}

describe.each(["production", "development"])("WebSocket upgrade ownership (%s, #1500)", (env) => {
  it("keeps an idle socket alive after public HTTP warmup and closes with a close frame", async () => {
    const { port, publicServer, internalServer, nextUpgrades, bodies } = await startServer(env);
    expect(await getHttp(port)).toBe("http-ok");
    expect(await getHttp(port)).toBe("http-ok");
    expect(publicServer.listenerCount("upgrade")).toBe(1);
    expect(internalServer.listenerCount("upgrade")).toBe(1);

    const { ws, events, closed } = await connectWs(port);
    const pong = once(ws, "pong");
    ws.ping("idle-probe");
    await pong;
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(events).toEqual([]);
    expect(bodies).toEqual([]);
    expect(nextUpgrades).not.toHaveBeenCalled();
    ws.close(1000, "test_done");
    expect((await closed)[0]).toBe(1000);
    expect(await getHttp(port)).toBe("http-ok");
  });

  it.each(["public-http", "private-http", "websocket"])(
    "delivers two turns on one connection when the first request is %s",
    async (firstRequest) => {
      const { port, publicServer, internalServer, nextUpgrades, bodies } = await startServer(env);
      if (firstRequest === "public-http") expect(await getHttp(port)).toBe("http-ok");
      if (firstRequest === "private-http") {
        const { port: internalPort } = internalServer.address() as import("node:net").AddressInfo;
        expect(await getHttp(internalPort)).toBe("http-ok");
      }
      const { ws, events, closed } = await connectWs(port);
      for (let turn = 0; turn < 2; turn++) {
        ws.send(
          JSON.stringify({
            type: "response.create",
            model: "test-model",
            input: `turn-${turn}`,
            ...(turn === 1 ? { previous_response_id: "response_1" } : {}),
          })
        );
        await vi.waitFor(() => {
          expect(ws.readyState).toBe(WebSocket.OPEN);
          expect(events).toHaveLength((turn + 1) * 2);
        });
        expect(events[turn * 2].type).toBe("response.created");
        expect(events[turn * 2 + 1]).toEqual({
          type: "response.completed",
          response: { id: `response_${turn + 1}` },
        });
      }
      expect(bodies).toEqual([
        expect.objectContaining({ input: "turn-0", stream: true }),
        expect.objectContaining({
          input: "turn-1",
          previous_response_id: "response_1",
          stream: true,
        }),
      ]);
      expect(publicServer.listenerCount("upgrade")).toBe(1);
      expect(internalServer.listenerCount("upgrade")).toBe(1);
      expect(nextUpgrades).not.toHaveBeenCalled();
      ws.close(1000, "test_done");
      expect((await closed)[0]).toBe(1000);
      expect(await getHttp(port)).toBe("http-ok");
    }
  );
});
