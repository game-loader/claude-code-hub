import { createHash } from "node:crypto";
import { addProbe, JsonProbe, probeSpec } from "@/lib/memory/json-probe";
import { getRedisClient } from "@/lib/redis/client";
import type { Provider } from "@/types/provider";
import { shouldForceCodexResponsesStreamHandling } from "../proxy/response-handler";
import type { ProxySession } from "../proxy/session";
import { ProbedSseFrames } from "../proxy/stream-gate/probed-sse-frames";

export type ResponsesContinuationOwner = {
  providerId: number;
  endpointId: number | null;
  baseUrl: string;
  transport: "http" | "websocket";
  credentialFingerprint?: string;
};
type Entry = ResponsesContinuationOwner & { expiresAt: number };
const TTL_MS = 3_600_000;
const MAX_ENTRIES = 16_384;
const MAX_ID_LENGTH = 256;
declare global {
  var __cchResponsesContinuationOwners: Map<string, Entry> | undefined;
}
const owners = (globalThis.__cchResponsesContinuationOwners ??= new Map<string, Entry>());

export function responsesProviderCredentialFingerprint(provider: Pick<Provider, "key">): string {
  return createHash("sha256")
    .update(provider.key ?? "")
    .digest("hex");
}

function keyFor(session: ProxySession, responseId: string): string | null {
  const keyId = session.authState?.key?.id;
  if (keyId == null || !validId(responseId)) return null;
  return `cch:responses-owner:${createHash("sha256")
    .update(JSON.stringify([keyId, responseId]))
    .digest("hex")}`;
}
function validId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= MAX_ID_LENGTH &&
    !/\s/.test(id) &&
    !id.includes("\u0000") &&
    !id.includes("\u007f")
  );
}
function validEntry(value: unknown): value is Entry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Entry;
  try {
    return (
      Number.isInteger(entry.providerId) &&
      entry.providerId > 0 &&
      (entry.endpointId === null || (Number.isInteger(entry.endpointId) && entry.endpointId > 0)) &&
      (entry.transport === "http" || entry.transport === "websocket") &&
      (entry.credentialFingerprint === undefined ||
        /^[a-f0-9]{64}$/.test(entry.credentialFingerprint)) &&
      ["http:", "https:"].includes(new URL(entry.baseUrl).protocol) &&
      Number.isFinite(entry.expiresAt) &&
      entry.expiresAt > Date.now()
    );
  } catch {
    return false;
  }
}
function prune(): void {
  for (const [key, entry] of owners) {
    if (entry.expiresAt > Date.now() && owners.size <= MAX_ENTRIES) break;
    owners.delete(key);
  }
}
async function redisBudget<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("responses_owner_redis_timeout")), 250);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function rememberResponsesContinuationOwner(
  session: ProxySession,
  responseId: string,
  owner: ResponsesContinuationOwner
): Promise<void> {
  const key = keyFor(session, responseId);
  const entry = { ...owner, expiresAt: Date.now() + TTL_MS };
  if (!key || !validEntry(entry)) return;
  owners.delete(key);
  owners.set(key, entry);
  prune();
  try {
    const redis = getRedisClient({ allowWhenRateLimitDisabled: true });
    if (redis?.status === "ready")
      await redisBudget(redis.setex(key, TTL_MS / 1000, JSON.stringify(entry)));
  } catch {
    /* Local ownership remains usable during a Redis outage. */
  }
}

export async function getResponsesContinuationOwner(
  session: ProxySession,
  responseId: string
): Promise<ResponsesContinuationOwner | null> {
  const key = keyFor(session, responseId);
  if (!key) return null;
  prune();
  let entry = owners.get(key);
  try {
    const redis = getRedisClient({ allowWhenRateLimitDisabled: true });
    if (redis?.status === "ready") {
      const raw = await redisBudget(redis.get(key));
      const shared: unknown = raw ? JSON.parse(raw) : null;
      if (validEntry(shared)) entry = shared;
    }
  } catch {
    /* The bounded local cache covers this worker. */
  }
  if (!validEntry(entry)) return null;
  const { expiresAt: _, ...route } = entry;
  return route;
}

function responseProbe() {
  const spec = probeSpec();
  let directId: string | null = null;
  let nestedId: string | null = null;
  addProbe(spec, "id", BigInt(1), (v) => {
    directId = v.kind === "string" && validId(v.text) ? v.text : null;
    return directId !== null;
  });
  addProbe(spec, "response.id", BigInt(2), (v) => {
    nestedId = v.kind === "string" && validId(v.text) ? v.text : null;
    return nestedId !== null;
  });
  addProbe(spec, "type", BigInt(4), (v) => v.kind === "string" && v.text === "response.completed");
  addProbe(spec, "object", BigInt(8), (v) => v.kind === "string" && v.text === "response");
  for (const path of ["error", "response.error"])
    addProbe(spec, path, BigInt(16), (v) => v.nonempty);
  for (const path of ["status", "response.status"]) {
    addProbe(spec, path, BigInt(32), (v) => v.kind !== "string" || v.text !== "completed");
  }
  const parser = new JsonProbe(spec, undefined, MAX_ID_LENGTH);
  return {
    feed: (text: string) => parser.feed(text),
    id: () => {
      if (!parser.finish() || (parser.facts & (BigInt(16) | BigInt(32))) !== BigInt(0)) return null;
      if ((parser.facts & (BigInt(2) | BigInt(4))) === (BigInt(2) | BigInt(4))) return nestedId;
      if ((parser.facts & (BigInt(1) | BigInt(8))) === (BigInt(1) | BigInt(8))) return directId;
      return null;
    },
    finish: () => ({ verdict: "neutral" as const, acceptTerminal: false }),
  };
}

/** Observe bytes once, before delivery; do not buffer output, reasoning or compaction strings. */
export function captureResponsesContinuationOwner(
  session: ProxySession,
  response: Response,
  owner: ResponsesContinuationOwner
): Response {
  if (
    session.requestUrl.pathname !== "/v1/responses" ||
    !session.authState?.key ||
    !response.ok ||
    !response.body
  )
    return response;
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  const streaming =
    type.includes("text/event-stream") ||
    shouldForceCodexResponsesStreamHandling(session, response);
  if (!streaming && !type.includes("application/json") && !type.includes("+json")) return response;
  let probe = responseProbe();
  const decoder = new TextDecoder();
  const ids: string[] = [];
  const parser = streaming
    ? new ProbedSseFrames("openai-responses", Number.MAX_SAFE_INTEGER, undefined, () => {
        probe = responseProbe();
        return probe;
      })
    : null;
  const observe = () => {
    const id = probe.id();
    if (id) ids.push(id);
  };
  const persist = async () => {
    for (const id of ids.splice(0)) await rememberResponsesContinuationOwner(session, id, owner);
  };
  return new Response(
    response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        async transform(chunk, controller) {
          if (parser)
            parser.visit(chunk, () => {
              observe();
            });
          else probe.feed(decoder.decode(chunk, { stream: true }));
          await persist();
          controller.enqueue(chunk);
        },
        async flush() {
          if (parser)
            parser.finishVisit(() => {
              observe();
            });
          else {
            probe.feed(decoder.decode());
            observe();
          }
          await persist();
        },
      })
    ),
    { status: response.status, statusText: response.statusText, headers: response.headers }
  );
}

export function clearResponsesContinuationOwnersForTests(): void {
  owners.clear();
}
