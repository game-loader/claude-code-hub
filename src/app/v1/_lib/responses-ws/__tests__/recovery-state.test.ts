import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProxySession } from "../../proxy/session";
const redisMock = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/redis/client", () => ({ getRedisClient: () => redisMock.client }));
import {
  clearResponsesWsRecoveryStateForTests,
  getResponsesWsRecoveryExcludedProviderIds,
  rememberResponsesWsRecoveryFailure,
} from "../recovery-state";

function session(keyId = 5, thread = "thread-1", model = "gpt-5.5"): ProxySession {
  return {
    headers: new Headers({ "thread-id": thread }),
    sessionId: "session-1",
    authState: { key: { id: keyId } },
    getOriginalModel: () => model,
    request: { message: { model } },
  } as unknown as ProxySession;
}
describe("Responses WS recovery exclusions", () => {
  beforeEach(() => {
    clearResponsesWsRecoveryStateForTests();
    redisMock.client = null;
  });
  afterEach(() => vi.useRealTimers());
  it("avoids a failed provider after WS reconnect while preserving key, thread and model isolation", async () => {
    const first = session();
    first.headers.set("x-cch-responses-ws-session", "old-socket");
    await rememberResponsesWsRecoveryFailure(first, 792);
    const replay = session();
    replay.headers.set("x-cch-responses-ws-session", "new-socket");
    expect(await getResponsesWsRecoveryExcludedProviderIds(replay)).toEqual([792]);
    for (const other of [
      session(6),
      session(5, "thread-2"),
      session(5, "thread-1", "other-model"),
    ]) {
      expect(await getResponsesWsRecoveryExcludedProviderIds(other)).toEqual([]);
    }
  });
  it("expires exclusions so later turns can try the provider again", async () => {
    vi.useFakeTimers();
    await rememberResponsesWsRecoveryFailure(session(), 792);
    await vi.advanceTimersByTimeAsync(120_001);
    expect(await getResponsesWsRecoveryExcludedProviderIds(session())).toEqual([]);
  });
  it("does not record unbound or invalid provider identifiers", async () => {
    const unbound = session();
    unbound.authState = null;
    await rememberResponsesWsRecoveryFailure(unbound, 792);
    for (const id of [0, -1, NaN]) await rememberResponsesWsRecoveryFailure(session(), id);
    expect(await getResponsesWsRecoveryExcludedProviderIds(session())).toEqual([]);
    expect(await getResponsesWsRecoveryExcludedProviderIds(unbound)).toEqual([]);
  });
  it("shares exclusions through Redis across process-local resets", async () => {
    const records = new Map<string, Map<string, number>>();
    const writes: Array<() => void> = [];
    const multi = {
      zadd: vi.fn((key: string, expires: number, id: number) => {
        writes.push(() => {
          const scope = records.get(key) ?? new Map();
          scope.set(String(id), expires);
          records.set(key, scope);
        });
        return multi;
      }),
      expire: vi.fn(() => multi),
      exec: vi.fn(async () => {
        for (const write of writes.splice(0)) write();
      }),
    };
    const client = {
      status: "ready",
      multi: () => multi,
      zrangebyscore: vi.fn(async (key: string, now: number) =>
        [...(records.get(key) ?? [])].filter(([, expires]) => expires >= now).map(([id]) => id)
      ),
    };
    redisMock.client = client;
    await rememberResponsesWsRecoveryFailure(session(), 792);
    clearResponsesWsRecoveryStateForTests();
    expect(await getResponsesWsRecoveryExcludedProviderIds(session())).toEqual([792]);
    expect(multi.expire).toHaveBeenCalledWith(
      expect.stringMatching(/^cch:responses-ws-recovery:[a-f0-9]{64}$/),
      120
    );
  });
  it("falls back locally when Redis reads or writes fail", async () => {
    redisMock.client = {
      status: "ready",
      multi: () => {
        throw new Error("unavailable");
      },
      zrangebyscore: async () => {
        throw new Error("unavailable");
      },
    };
    await rememberResponsesWsRecoveryFailure(session(), 792);
    expect(await getResponsesWsRecoveryExcludedProviderIds(session())).toEqual([792]);
  });
  it("bounds failure history and ignores malformed shared identifiers", async () => {
    for (let id = 1; id <= 20; id++) await rememberResponsesWsRecoveryFailure(session(), id);
    expect(await getResponsesWsRecoveryExcludedProviderIds(session())).toHaveLength(16);
    redisMock.client = {
      status: "ready",
      zrangebyscore: async () => ["invalid", "-1", "0", "792"],
    };
    expect(await getResponsesWsRecoveryExcludedProviderIds(session())).toContain(792);
  });
  it("bounds Redis wait time without breaking the local recovery hint", async () => {
    vi.useFakeTimers();
    const never = new Promise(() => {});
    const multi = { zadd: () => multi, expire: () => multi, exec: () => never };
    redisMock.client = { status: "ready", multi: () => multi, zrangebyscore: () => never };
    const write = rememberResponsesWsRecoveryFailure(session(), 792);
    await vi.advanceTimersByTimeAsync(251);
    await write;
    const read = getResponsesWsRecoveryExcludedProviderIds(session());
    await vi.advanceTimersByTimeAsync(251);
    expect(await read).toEqual([792]);
  });
});
