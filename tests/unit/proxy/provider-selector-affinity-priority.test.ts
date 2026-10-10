import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Provider } from "@/types/provider";
import { ensureInternalSecret } from "@/app/v1/_lib/responses-ws/internal-secret";
import type { ResponsesWsContinuationRoute } from "@/app/v1/_lib/responses-ws/upstream-adapter";

/**
 * F3a nomination priority inside ProxyProviderResolver.ensure():
 * with "ignore client session id" off: explicit session binding > affinity hint > weighted random;
 * with it on (product default) fingerprintable requests skip the session binding read entirely.
 * An affinity hint must still pass the full hard validation either way.
 */

const wsMocks = vi.hoisted(() => ({
  route: vi.fn(() => null as ResponsesWsContinuationRoute | null),
}));
vi.mock("@/app/v1/_lib/responses-ws/upstream-adapter", () => ({
  getResponsesWsContinuationRoute: wsMocks.route,
}));

const envControl = vi.hoisted(() => ({ affinityEnabled: true }));

const settingsControl = vi.hoisted(() => ({ ignoreClientSessionId: true }));

const storeMocks = vi.hoisted(() => ({
  lookup: vi.fn(async () => null as unknown),
  put: vi.fn(async () => {}),
  tombstone: vi.fn(async () => {}),
}));

const circuitBreakerMocks = vi.hoisted(() => ({
  isCircuitOpen: vi.fn(async (_providerId: number) => false),
  getCircuitState: vi.fn(() => "closed"),
}));

const vendorTypeCircuitMocks = vi.hoisted(() => ({
  isVendorTypeCircuitOpen: vi.fn(async () => false),
}));

const sessionManagerMocks = vi.hoisted(() => ({
  SessionManager: {
    getSessionProvider: vi.fn(async () => null as number | null),
    clearSessionProvider: vi.fn(async () => undefined),
    // 版本化绑定读不可用 -> findReusable 走 legacy getSessionProvider 回退，测试意图不变
    getSessionBindingSnapshot: vi.fn(async () => ({
      status: "unavailable" as const,
      reason: "redis_unavailable",
      capabilityState: "unknown",
      legacyFallbackAllowed: true,
    })),
    isSessionProviderCoolingDown: vi.fn(async () => ({
      status: "ok" as const,
      coolingDown: false,
      legacyFallbackAllowed: false as const,
    })),
  },
}));

const providerRepositoryMocks = vi.hoisted(() => ({
  findProviderById: vi.fn(async () => null as Provider | null),
  findAllProviders: vi.fn(async () => [] as Provider[]),
}));

const rateLimitMocks = vi.hoisted(() => ({
  RateLimitService: {
    checkCostLimitsWithLease: vi.fn(async () => ({ allowed: true })),
    checkTotalCostLimit: vi.fn(async () => ({ allowed: true, current: 0 })),
    checkAndTrackProviderSession: vi.fn(async () => ({
      allowed: true,
      count: 1,
      tracked: true,
      referenced: false,
    })),
  },
}));

vi.mock("@/lib/circuit-breaker", () => circuitBreakerMocks);
vi.mock("@/lib/vendor-type-circuit-breaker", () => vendorTypeCircuitMocks);
vi.mock("@/lib/session-manager", () => sessionManagerMocks);
vi.mock("@/repository/provider", () => providerRepositoryMocks);
vi.mock("@/lib/rate-limit", () => rateLimitMocks);
vi.mock("@/repository/provider-groups", () => ({
  getGroupCostMultiplier: vi.fn(async () => 1),
}));
vi.mock("@/lib/utils/timezone", () => ({
  resolveSystemTimezone: vi.fn(async () => "UTC"),
}));
vi.mock("@/app/v1/_lib/proxy/provider-selector-settings-cache", () => ({
  getVerboseProviderErrorCached: vi.fn(async () => false),
}));
vi.mock("@/app/v1/_lib/proxy/affinity/affinity-store", () => ({
  getAffinityStore: () => storeMocks,
}));
vi.mock("@/lib/system-settings/proxy-runtime", () => ({
  getProxyRuntimeSettings: vi.fn(async () => ({
    streamGateMode: "off" as const,
    affinityIgnoreClientSessionId: settingsControl.ignoreClientSessionId,
  })),

  isCacheEffectivenessEnabled: () => false,
}));
vi.mock("@/lib/config/env.schema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config/env.schema")>();
  const baseEnv = actual.EnvSchema.parse({});
  return {
    ...actual,
    getEnvConfig: () => ({
      ...baseEnv,
      ENABLE_PREFIX_AFFINITY: envControl.affinityEnabled,
      // 指标模式（F3b）默认开启会独立建指纹状态；本文件聚焦提名优先级，显式关闭
      ENABLE_CACHE_EFFECTIVENESS: false,
      PREFIX_AFFINITY_WINDOW: 8,
      PREFIX_AFFINITY_TTL_SECONDS: 3600,
    }),
  };
});

import { ProxyProviderResolver } from "@/app/v1/_lib/proxy/provider-selector";
import {
  rememberResponsesContinuationOwner,
  clearResponsesContinuationOwnersForTests,
  responsesProviderCredentialFingerprint,
} from "@/app/v1/_lib/responses-ws/response-ownership";
import {
  clearResponsesWsRecoveryStateForTests,
  rememberResponsesWsRecoveryFailure,
} from "@/app/v1/_lib/responses-ws/recovery-state";

function makeProvider(id: number, overrides: Partial<Provider> = {}): Provider {
  return {
    id,
    name: `provider_${id}`,
    isEnabled: true,
    providerType: "claude",
    groupTag: null,
    weight: 1,
    priority: 0,
    costMultiplier: 1,
    disableSessionReuse: false,
    allowedModels: null,
    allowedClients: [],
    blockedClients: [],
    providerVendorId: null,
    activeTimeStart: null,
    activeTimeEnd: null,
    limit5hUsd: null,
    limitDailyUsd: null,
    dailyResetMode: "fixed",
    dailyResetTime: "00:00",
    limitWeeklyUsd: null,
    limitMonthlyUsd: null,
    limitTotalUsd: null,
    totalCostResetAt: null,
    limitConcurrentSessions: 0,
    ...overrides,
  } as unknown as Provider;
}

const claudeMessage = {
  model: "claude-sonnet-4-5",
  system: "You are helpful.",
  messages: [{ role: "user", content: "hello" }],
};

// Minimal ProxySession stub; loose typing matches sibling selector tests.
function makeSession(overrides: Record<string, unknown> = {}): any {
  // 链条目联动：addProviderToChain 推入、getProviderChain 读出（覆盖粘性选择去重逻辑）
  const chainItems: Array<Record<string, unknown>> = [];
  const session: any = {
    sessionId: null,
    provider: null,
    affinity: null,
    originalFormat: "claude",
    userAgent: "claude-cli/2.0.0",
    authState: { key: { id: 5, providerGroup: "default" }, user: null },
    request: { message: claudeMessage },
    getEndpointPolicy: () => ({ kind: "default" }),
    shouldReuseProvider: () => false,
    getOriginalModel: () => "claude-sonnet-4-5",
    getCurrentModel: () => null,
    setProvider(p: Provider) {
      session.provider = p;
    },
    addProviderToChain: vi.fn((provider: Provider, metadata: Record<string, unknown> = {}) => {
      chainItems.push({ id: provider.id, ...metadata });
    }),
    getProviderChain: vi.fn(() => chainItems),
    setLastSelectionContext: vi.fn((ctx: unknown) => {
      session._ctx = ctx;
    }),
    getLastSelectionContext: vi.fn(() => session._ctx ?? null),
    setGroupCostMultiplier: vi.fn(),
    getProvidersSnapshot: vi.fn(async () => [makeProvider(55)]),
    recordProviderSessionRef: vi.fn(),
    setSessionIdentityMetadata: vi.fn((metadata: unknown) => {
      session._sessionIdentityMetadata = metadata;
    }),
  };
  return Object.assign(session, overrides);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearResponsesWsRecoveryStateForTests();
  clearResponsesContinuationOwnersForTests();
  envControl.affinityEnabled = true;
  settingsControl.ignoreClientSessionId = true;
  storeMocks.lookup.mockResolvedValue(null);
  circuitBreakerMocks.isCircuitOpen.mockResolvedValue(false);
  circuitBreakerMocks.getCircuitState.mockReturnValue("closed");
  rateLimitMocks.RateLimitService.checkCostLimitsWithLease.mockResolvedValue({ allowed: true });
  rateLimitMocks.RateLimitService.checkTotalCostLimit.mockResolvedValue({
    allowed: true,
    current: 0,
  });
  rateLimitMocks.RateLimitService.checkAndTrackProviderSession.mockResolvedValue({
    allowed: true,
    count: 1,
    tracked: true,
    referenced: false,
  });
});

describe("ensure() nomination priority", () => {
  test("ignore-session off: explicit session binding wins while affinity writeback state is initialized", async () => {
    settingsControl.ignoreClientSessionId = false;
    sessionManagerMocks.SessionManager.getSessionProvider.mockResolvedValue(91);
    providerRepositoryMocks.findProviderById.mockResolvedValue(makeProvider(91));
    storeMocks.lookup.mockResolvedValue({
      generation: "3",
      identityFp: "rootfp",
      hint: {
        providerId: 42,
        matchedFp: "deepfp",
        matchedIndex: 0,
      },
    });

    const session = makeSession({
      sessionId: "sess_bound",
      shouldReuseProvider: () => true,
    });

    const result = await ProxyProviderResolver.ensure(session);

    expect(result).toBeNull();
    expect(session.provider?.id).toBe(91);
    expect(storeMocks.lookup).toHaveBeenCalledTimes(1);
    // 复用命中轮次仍要指纹状态：供终态写回加深前缀与 F3b 落值
    expect(session.affinity).not.toBeNull();
    expect(session.affinity?.nominatedProviderId).toBeNull();
    expect(session.affinity?.matchedFp).toBeNull();
    expect(session.affinity?.identityFp).toBe("rootfp");
    expect(session.affinity?.generation).toBe("3");
  });

  test("affinity hit wins over weighted random and records affinity_hit in the chain", async () => {
    storeMocks.lookup.mockResolvedValue({
      generation: "0",
      identityFp: "rootfp",
      hint: {
        providerId: 42,
        matchedFp: "deepfp",
        matchedIndex: 0,
        tier: "conversation",
      },
    });
    providerRepositoryMocks.findProviderById.mockResolvedValue(makeProvider(42));

    const session = makeSession({ sessionId: "physical-session" });
    const result = await ProxyProviderResolver.ensure(session);

    expect(result).toBeNull();
    expect(session.provider?.id).toBe(42);
    expect(session.affinity?.nominatedProviderId).toBe(42);
    expect(session.affinity?.matchedFp).toBe("deepfp");
    expect(session.affinity?.identityFp).toBe("rootfp");
    expect(session.setSessionIdentityMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: `pfx:${session.affinity?.scopeTag}:rootfp`,
        kind: "prefix_affinity",
        fingerprint: "rootfp",
        fingerprints: expect.arrayContaining(["rootfp"]),
      })
    );
    expect(session.getProvidersSnapshot).not.toHaveBeenCalled();
    expect(session.addProviderToChain).toHaveBeenCalledWith(
      expect.objectContaining({ id: 42 }),
      expect.objectContaining({ reason: "affinity_hit", selectionMethod: "prefix_affinity" })
    );
    // 亲和提名已写入链：ensure 不得再补 initial_selection（否则决策链显示为加权随机初选）
    expect(session.getProviderChain().map((item: { reason?: string }) => item.reason)).toEqual([
      "affinity_hit",
    ]);

    const [, luaKeysCount] = storeMocks.lookup.mock.calls[0] as unknown as [string, string[]];
    expect(Array.isArray(luaKeysCount)).toBe(true);
  });

  test("affinity miss falls back to weighted random selection", async () => {
    storeMocks.lookup.mockResolvedValue({
      generation: "0",
      identityFp: "deepfp",
      hint: null,
    });
    const session = makeSession();
    const result = await ProxyProviderResolver.ensure(session);

    expect(result).toBeNull();
    expect(storeMocks.lookup).toHaveBeenCalledTimes(1);
    expect(session.provider?.id).toBe(55);
    expect(session.affinity).not.toBeNull();
    expect(session.affinity?.nominatedProviderId).toBeNull();
    expect(session.affinity?.identityFp).toBe("deepfp");
  });

  test("affinity hit that fails hard validation falls back without nomination", async () => {
    storeMocks.lookup.mockResolvedValue({
      generation: "0",
      identityFp: "rootfp",
      hint: {
        providerId: 42,
        matchedFp: "deepfp",
        matchedIndex: 0,
        tier: "conversation",
      },
    });
    providerRepositoryMocks.findProviderById.mockResolvedValue(
      makeProvider(42, { isEnabled: false })
    );

    const session = makeSession();
    const result = await ProxyProviderResolver.ensure(session);

    expect(result).toBeNull();
    expect(session.provider?.id).toBe(55);
    expect(session.affinity?.matchedFp).toBe("deepfp");
    expect(session.affinity?.nominatedProviderId).toBeNull();
  });

  test("circuit-open affinity candidate is rejected by hard validation", async () => {
    storeMocks.lookup.mockResolvedValue({
      generation: "0",
      identityFp: "rootfp",
      hint: {
        providerId: 42,
        matchedFp: "deepfp",
        matchedIndex: 0,
        tier: "conversation",
      },
    });
    providerRepositoryMocks.findProviderById.mockResolvedValue(makeProvider(42));
    circuitBreakerMocks.isCircuitOpen.mockImplementation(async (id: number) => id === 42);

    const session = makeSession();
    await ProxyProviderResolver.ensure(session);

    expect(session.provider?.id).toBe(55);
    expect(session.affinity?.nominatedProviderId).toBeNull();
  });

  test("env flag off and ignore-session setting off disable affinity entirely", async () => {
    envControl.affinityEnabled = false;
    settingsControl.ignoreClientSessionId = false;

    const session = makeSession();
    const result = await ProxyProviderResolver.ensure(session);

    expect(result).toBeNull();
    expect(storeMocks.lookup).not.toHaveBeenCalled();
    expect(session.affinity).toBeNull();
    expect(session.provider?.id).toBe(55);
  });
});

describe("Responses WS continuation routing", () => {
  function continuationSession() {
    const headers = new Headers({
      "x-cch-client-transport": "websocket",
      "x-cch-responses-ws-forward": "1",
      "x-cch-internal-secret": ensureInternalSecret(),
      "x-cch-responses-ws-session": "client-ws",
    });
    return makeSession({
      headers,
      originalFormat: "response",
      sessionId: "public-session",
      request: {
        message: {
          model: "gpt-5.5",
          store: false,
          previous_response_id: "resp_winner",
          input: "delta",
        },
      },
      getOriginalModel: () => "gpt-5.5",
      disableStreamingHedge: vi.fn(),
    });
  }
  beforeEach(() => {
    wsMocks.route.mockReset();
  });

  test("keeps the live q647 socket even when q727 has higher priority and session affinity is ignored", async () => {
    const route = { providerId: 647, endpointId: 22, baseUrl: "https://winner.example/v1" };
    wsMocks.route.mockReturnValue(route);
    providerRepositoryMocks.findProviderById.mockResolvedValue(
      makeProvider(647, { providerType: "codex", priority: 1, disableSessionReuse: true })
    );
    const session = continuationSession();
    expect(await ProxyProviderResolver.ensure(session)).toBeNull();
    expect(session.provider.id).toBe(647);
    expect(session.responsesWsContinuationRoute).toEqual(route);
    expect(session.disableStreamingHedge).toHaveBeenCalled();
    expect(sessionManagerMocks.SessionManager.getSessionProvider).not.toHaveBeenCalled();
    expect(session.getProvidersSnapshot).not.toHaveBeenCalled();
    expect(wsMocks.route).toHaveBeenCalledWith("client-ws", "resp_winner");
  });

  test("requests context recovery when the completed response has no live socket", async () => {
    wsMocks.route.mockReturnValue(null);
    const session = continuationSession();
    session.getProvidersSnapshot.mockResolvedValue([makeProvider(727, { providerType: "codex" })]);
    expect(await ProxyProviderResolver.ensure(session)).toBeNull();
    expect(session.responsesWsContinuationErrorReason).toBe("ws_continuation_unavailable");
    expect(session.disableStreamingHedge).toHaveBeenCalled();
  });

  test("does not send an incremental request to another provider when its owner is disabled", async () => {
    wsMocks.route.mockReturnValue({
      providerId: 647,
      endpointId: 22,
      baseUrl: "https://winner.example/v1",
    });
    providerRepositoryMocks.findProviderById.mockResolvedValue(
      makeProvider(647, { providerType: "codex", isEnabled: false })
    );
    const session = continuationSession();
    await expect(ProxyProviderResolver.ensure(session)).rejects.toMatchObject({
      name: "ResponsesWsContinuationError",
    });
    expect(session.getProvidersSnapshot).not.toHaveBeenCalled();
  });

  test("does not switch providers when the live socket owner reaches its concurrency limit", async () => {
    wsMocks.route.mockReturnValue({
      providerId: 647,
      endpointId: 22,
      baseUrl: "https://winner.example/v1",
    });
    providerRepositoryMocks.findProviderById.mockResolvedValue(
      makeProvider(647, { providerType: "codex" })
    );
    rateLimitMocks.RateLimitService.checkAndTrackProviderSession.mockResolvedValue({
      allowed: false,
      count: 5,
      tracked: false,
      referenced: false,
    });
    const session = continuationSession();
    await expect(ProxyProviderResolver.ensure(session)).rejects.toMatchObject({
      name: "ResponsesWsContinuationError",
    });
    expect(session.getProvidersSnapshot).not.toHaveBeenCalled();
  });

  test("allows a stored continuation without a retained owner to use normal provider selection", async () => {
    wsMocks.route.mockReturnValue(null);
    const session = continuationSession();
    session.request.message.store = true;
    session.getProvidersSnapshot.mockResolvedValue([makeProvider(727, { providerType: "codex" })]);
    expect(await ProxyProviderResolver.ensure(session)).toBeNull();
    expect(session.provider.id).toBe(727);
    expect(session.disableStreamingHedge).toHaveBeenCalled();
  });
});

describe("HTTP and fallback reply ownership beats prefix affinity", () => {
  function request(headers = new Headers()) {
    return makeSession({
      originalFormat: "response",
      headers,
      sessionId: "changed-thread",
      getOriginalModel: () => "gpt-5.5",
      disableStreamingHedge: vi.fn(),
      request: {
        message: {
          model: "gpt-5.5",
          previous_response_id: "resp_opai",
          store: false,
          input: [{ type: "function_call_output", call_id: "call_1", output: "delta" }],
        },
      },
      getProvidersSnapshot: vi.fn(async () => [
        makeProvider(647, { providerType: "codex", priority: 0 }),
      ]),
    });
  }
  test.each([false, true])(
    "pins a known reply ahead of shallow q647 affinity (ignore session=%s)",
    async (ignore) => {
      settingsControl.ignoreClientSessionId = ignore;
      const session = request();
      const source = makeProvider(792, {
        providerType: "codex",
        priority: 1,
        disableSessionReuse: true,
      });
      providerRepositoryMocks.findProviderById.mockImplementation(async (id) =>
        id === 792 ? source : makeProvider(id, { providerType: "codex" })
      );
      sessionManagerMocks.SessionManager.getSessionProvider.mockResolvedValue(647);
      storeMocks.lookup.mockResolvedValue({
        generation: "1",
        hint: { providerId: 647, matchedFp: "shallow", matchedIndex: 0 },
      });
      const route = {
        providerId: 792,
        endpointId: 42,
        baseUrl: "https://opai.example/v1",
        transport: "http" as const,
      };
      await rememberResponsesContinuationOwner(session, "resp_opai", route);
      expect(await ProxyProviderResolver.ensure(session)).toBeNull();
      expect(session.provider.id).toBe(792);
      expect(session.responsesContinuationOwner).toEqual(route);
      expect(storeMocks.lookup).not.toHaveBeenCalled();
      expect(sessionManagerMocks.SessionManager.getSessionProvider).not.toHaveBeenCalled();
      expect(session.getProvidersSnapshot).not.toHaveBeenCalled();
      expect(session.disableStreamingHedge).toHaveBeenCalled();
    }
  );
  test("keeps an HTTP-fallback owner on a trusted WS continuation with store=false", async () => {
    const headers = new Headers({
      "x-cch-client-transport": "websocket",
      "x-cch-responses-ws-forward": "1",
      "x-cch-internal-secret": ensureInternalSecret(),
      "x-cch-responses-ws-session": "new-client-socket",
    });
    const session = request(headers);
    providerRepositoryMocks.findProviderById.mockResolvedValue(
      makeProvider(792, { providerType: "codex" })
    );
    await rememberResponsesContinuationOwner(session, "resp_opai", {
      providerId: 792,
      endpointId: 42,
      baseUrl: "https://opai.example/v1",
      transport: "http",
    });
    expect(await ProxyProviderResolver.ensure(session)).toBeNull();
    expect(session.provider.id).toBe(792);
    expect(session.responsesWsContinuationErrorReason).toBeUndefined();
    expect(wsMocks.route).not.toHaveBeenCalled();
  });
  test("validates a shared WS owner once before using its exact retained socket", async () => {
    const headers = new Headers({
      "x-cch-client-transport": "websocket",
      "x-cch-responses-ws-forward": "1",
      "x-cch-internal-secret": ensureInternalSecret(),
      "x-cch-responses-ws-session": "client-socket",
    });
    const session = request(headers);
    const route = { providerId: 792, endpointId: 42, baseUrl: "https://opai.example/v1" };
    wsMocks.route.mockReturnValue(route);
    providerRepositoryMocks.findProviderById.mockResolvedValue(
      makeProvider(792, { providerType: "codex" })
    );
    await rememberResponsesContinuationOwner(session, "resp_opai", {
      ...route,
      transport: "websocket",
    });
    expect(await ProxyProviderResolver.ensure(session)).toBeNull();
    expect(session.responsesWsContinuationRoute).toEqual(route);
    expect(rateLimitMocks.RateLimitService.checkCostLimitsWithLease).toHaveBeenCalledOnce();
    expect(session.getProvidersSnapshot).not.toHaveBeenCalled();
  });
  test.each(["disabled", "credentials", "cost", "busy"])(
    "does not reroute a pinned reply when its owner is %s",
    async (mode) => {
      const session = request();
      const source = makeProvider(792, {
        providerType: "codex",
        key: "original",
        isEnabled: mode !== "disabled",
      });
      const credentialFingerprint = responsesProviderCredentialFingerprint(source);
      if (mode === "credentials") source.key = "rotated";
      providerRepositoryMocks.findProviderById.mockResolvedValue(source);
      if (mode === "cost")
        rateLimitMocks.RateLimitService.checkCostLimitsWithLease.mockResolvedValue({
          allowed: false,
        });
      if (mode === "busy")
        rateLimitMocks.RateLimitService.checkAndTrackProviderSession.mockResolvedValue({
          allowed: false,
          count: 5,
          tracked: false,
          referenced: false,
        });
      await rememberResponsesContinuationOwner(session, "resp_opai", {
        providerId: 792,
        endpointId: null,
        baseUrl: "https://opai.example/v1",
        transport: "http",
        credentialFingerprint,
      });
      await expect(ProxyProviderResolver.ensure(session)).rejects.toMatchObject({
        name: "ResponsesWsContinuationError",
      });
      expect(session.getProvidersSnapshot).not.toHaveBeenCalled();
      expect(storeMocks.lookup).not.toHaveBeenCalled();
    }
  );
  test("never uses another API key's reply ownership", async () => {
    const session = request();
    await rememberResponsesContinuationOwner(session, "resp_opai", {
      providerId: 792,
      endpointId: null,
      baseUrl: "https://opai.example/v1",
      transport: "http",
    });
    session.authState.key.id = 6;
    expect(await ProxyProviderResolver.ensure(session)).toBeNull();
    expect(session.provider.id).toBe(647);
    expect(session.responsesContinuationOwner).toBeUndefined();
  });
});

describe("full-context recovery after a failed continuation", () => {
  test("skips the failed priority-zero provider, session binding and affinity on the replay", async () => {
    const session = makeSession({
      headers: new Headers({ "thread-id": "recovery-thread" }),
      sessionId: "recovery-session",
      originalFormat: "response",
      request: { message: { model: "gpt-5.5", input: "full context" } },
      getOriginalModel: () => "gpt-5.5",
      shouldReuseProvider: () => true,
      getProvidersSnapshot: vi.fn(async () => [
        makeProvider(792, { providerType: "codex", priority: 0 }),
        makeProvider(647, { providerType: "codex", priority: 1 }),
      ]),
    });
    sessionManagerMocks.SessionManager.getSessionProvider.mockResolvedValue(792);
    storeMocks.lookup.mockResolvedValue({
      generation: "1",
      identityFp: "rootfp",
      hint: { providerId: 792, matchedFp: "fp", matchedIndex: 0 },
    });
    await rememberResponsesWsRecoveryFailure(session, 792);
    expect(await ProxyProviderResolver.ensure(session)).toBeNull();
    expect(session.provider.id).toBe(647);
    expect(sessionManagerMocks.SessionManager.getSessionProvider).not.toHaveBeenCalled();
    expect(storeMocks.lookup).not.toHaveBeenCalled();
    expect(await ProxyProviderResolver.pickRandomProviderWithExclusion(session, [])).toMatchObject({
      id: 647,
    });
  });
});
