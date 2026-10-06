# Responses WebSocket size limits

CCH uses one shared limit for Responses WebSocket messages in
`server-lib/responses-ws-limits.js`:

| Boundary | Limit |
| --- | --- |
| Client request message | 128 MiB |
| Upstream response message | 128 MiB |
| Outbound client response message, measured as UTF-8 JSON | 128 MiB |
| Pending message bytes per queue | 256 MiB |

The queue budget accommodates an in-flight message and another maximum-sized
message. Existing queue-count limits, pause/resume backpressure, send deadlines,
and disconnect cleanup still apply. SSE encoding has a separate bounded framing
budget because it adds `data:` prefixes around the message payload.

Previously, the client ingress limit was 32 MiB, upstream receive limit was
8 MiB, and outbound buffering limit was 1 MiB. A successful compaction response
containing a large `encrypted_content` could therefore be rejected by CCH.

OpenAI's [production best practices](https://developers.openai.com/api/docs/guides/production-best-practices)
document a 128 MiB limit for both compressed and decompressed HTTP zstd request
bodies on `/v1/responses`. The [WebSocket mode documentation](https://developers.openai.com/api/docs/guides/websocket-mode)
does not publish a message byte ceiling. The 128 MiB WebSocket ceiling above is
CCH's local policy; it is not a claim about an upstream service's maximum.

Request byte limits are distinct from model token/context limits. Upstream
`context_length_exceeded` errors retain their original semantics instead of
being reclassified as byte-size errors and converted to HTTP 413.

Run the size-limit regression suite and coverage checks with:

```bash
bunx vitest run --config tests/configs/responses-ws-size-limits.config.mts --coverage
```
