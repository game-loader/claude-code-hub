# Usage log transport implementation plan

**Goal:** Show a compact WS / HTTP tag next to each request's latency using the final upstream transport.

**Architecture:** Persist `upstreamTransport` in existing provider-chain JSON. Each forwarding attempt tracks its transport in its own ProxySession; winner synchronization copies the winner's value. Both usage log tables use one badge and resolver. Existing rows with unambiguous WS decision markers remain readable; rows without evidence display an unknown marker.

**Tech stack:** TypeScript, React, Next.js, next-intl, Vitest.

**Spec:** The current user's request to label usage records with WS or HTTP for latency comparisons, and the agreed scope of actual CCH-to-upstream transport.

**Constraints:** No emoji; UI strings must use all five locale catalogs; new features require at least 80% unit coverage; run build, lint, lint:fix, typecheck, and test before committing. Preserve local `.gitignore` edits. No production restart is included.

## Task 1: Record actual upstream transport

Files: `src/types/message.ts`, `src/app/v1/_lib/proxy/session.ts`, `src/app/v1/_lib/proxy/forwarder.ts`, and proxy unit tests.

Interface:

```ts
type UpstreamTransport = "websocket" | "http";
// ProxySession.upstreamTransport: UpstreamTransport | null
// ProviderChainItem.upstreamTransport?: UpstreamTransport
```

- [ ] Verify WS success, HTTP fallback, and final supplier attempts with forwarding tests.
- [ ] Reset attempt transport at dispatch start. Set WS before an actual adapter attempt and HTTP before actual HTTP dispatch.
- [ ] Include the transport on provider-chain records and copy it when a hedge winner replaces the original session.
- [ ] Keep stored JSON backward compatible and avoid schema migrations.

## Task 2: Display transport in both logs tables

Files: shared transport resolver in `src/lib/utils/`, shared badge in the dashboard logs components, regular and virtualized logs tables, five `dashboard.json` catalogs, and resolver/component tests.

Interface:

```ts
export function getUsageLogTransport(
  chain: ProviderChainItem[] | null | undefined
): "websocket" | "http" | null;
```

- [ ] Cover final HTTP after a WS failure, final WS after retries, and a hedge winner with a different loser transport.
- [ ] Prefer explicit metadata on the winning/final attempt. Restrict legacy WS marker inference to that attempt/provider; return null for ambiguous evidence.
- [ ] Render translated WS, HTTP, and unknown labels beside duration in both tables, with a translated tooltip identifying upstream transport.
- [ ] Verify both tables render the shared badge and the resolver/component reach 80% coverage.

## Task 3: Validate and integrate

- [ ] Run targeted transport tests and continuation-recovery regression tests.
- [ ] Run `bun run build`, `bun run lint`, `bun run lint:fix`, `bun run typecheck`, and `bun run test`.
- [ ] Commit and push the branch; target `dev` for the PR and promote the verified tree to `main` for deployment as requested in this conversation.
- [ ] Report validation evidence, tag meaning, and that deployment/restart remains outstanding.
