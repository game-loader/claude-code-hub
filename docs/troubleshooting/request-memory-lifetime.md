# Request memory held after abnormal Responses turns

Request leases are owned by the response and its actual background consumers.
An HTTP error status alone does not release them: the response must finish,
fail, be cancelled, or be abandoned by a disconnected client.

## Cleanup guarantees

- The public proxy binds the incoming request's abort signal to root response
  ownership, even when the framework never reads or cancels an error body.
- Responses WS terminal events (including `error`, `response.failed`, and
  `[DONE]`) finish the turn after the terminal send callback. The internal HTTP
  request and response are destroyed; internal HTTP EOF is not required.
- Forced WS settlement destroys both transports, including a late response
  arriving after the turn has already ended.
- Client close also settles a fatal turn whose send callback is still pending,
  even if callback invalidation removes that callback and its timer.
- Response cancellation ends root ownership immediately. If the source cancel
  hook is still running, it remains a background owner rather than trapping the
  root forever. The existing background grace and body-disposal hooks apply.

## Idle safeguard

`REQUEST_MEMORY_RESPONSE_IDLE_TIMEOUT_MS` defaults to `600000` (10 minutes).
It starts after the proxy handler returns a response and resets when the
downstream reads a nonempty chunk. It bounds unconsumed error bodies, blocked
reads, and connected clients which stop reading; it is not a total stream limit.
Increase it if legitimate responses can be silent for more than 10 minutes.

Expiry errors the client response and cancels its source. Real background
consumers keep their leases until they finish or exhaust
`REQUEST_MEMORY_BACKGROUND_GRACE_MS` (default 150 seconds, at least
`HEDGE_LOSER_DRAIN_TIMEOUT_MS + 30000`). An aborted handler which has not returned
yet is tracked as `response-operation`; a pending cancellation is tracked as
`response-source-cancel` in `drainingLabels`.

The worker logs an idle-expiry warning and logs stuck owner labels on forced
background cleanup. Recovery does not depend on garbage collection. This fix
does not reduce request sizes or solve an upstream's context/413 rejection.

## Regression checks

```bash
bunx vitest run --config tests/configs/request-memory-lifetime.config.mts --coverage
```

The suite holds Response objects alive while testing idle reclamation and stuck
cancel hooks. A real loopback HTTP/WS test runs 24 turns on one persistent WS
connection, including 400/413/429/499/502 JSON errors and SSE terminal events
whose source never emits EOF. Every turn returns lease usage and lifetime counts
to baseline without GC or forced recovery.
