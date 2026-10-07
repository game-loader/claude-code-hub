# Codex encrypted subagent messages

Codex Multi-Agent V2 advertises `collaboration.spawn_agent`, `send_message`, and
`followup_task` with an encrypted `message` parameter. Tool-generated task
messages normally arrive at the child as an `agent_message` item containing an
`encrypted_content` part. A `gAAAA...` task envelope is separate from encrypted
reasoning and context compaction.

If the child reports that it cannot interpret the encrypted payload, checking
that CCH preserves the bytes is insufficient: the upstream must also support
the encrypted agent-message protocol. CCH does not possess the upstream's
decryption keys.

## Optional plaintext compatibility

For clients connected to CCH's `/v1/responses` HTTP or WebSocket endpoint, set this
environment variable on the CCH process and restart it:

```dotenv
CCH_CODEX_PLAINTEXT_AGENT_MESSAGES=true
```

The default is `false`. This option applies to HTTP JSON responses, HTTP SSE
streams, and the client WebSocket bridge, whether CCH subsequently uses upstream
WebSocket or HTTP. Both request schemas and response function calls are handled
in the shared HTTP proxy pipeline. Other endpoints are unchanged.

When enabled, CCH removes the encrypted annotation from the three collaboration
tools' message schemas, including Responses Lite `additional_tools` items. For
upstream requests, it aliases the collaboration namespace to
`cch_collaboration_plaintext`, including replayed function calls and outputs.
This avoids reserved-tool schema checks on models that require their original
`collaboration.*` schemas. Response function calls restore the original namespace
before reaching Codex. For plaintext collaboration function calls without explicit encryption metadata,
it supplies `encrypted_function_args: []`. Codex 0.159.2 requires this explicit
empty list to dispatch the message as plaintext; a missing field still selects
the encrypted-message path.

New task instructions are readable in the API payload and may be readable in
request logs. Transport TLS is unchanged. This option does not modify reasoning,
compaction, unrelated tool schemas, explicit encryption metadata, or existing
opaque envelopes. It cannot recover an already encrypted task: start a new
conversation or resend the task after enabling compatibility. If the upstream
still returns encrypted arguments despite the modified schema, it remains
responsible for supporting them.

## Validation

The unit suite checks both tool-advertisement formats, HTTP JSON and fragmented
SSE responses, response item and completed response handling, the opt-in boundary,
stream cancellation, and preservation of ciphertext and unrelated encrypted fields:

```bash
bunx vitest run --config tests/configs/codex-agent-message-compat.config.mts --coverage
```

A local Codex 0.159.2 wire probe confirms that an explicit empty
`encrypted_function_args` list changes the child request from encrypted content
to `input_text`. A live Codex 0.159.2 probe through the patched bridge and the
configured upstream completed spawn, wait, and child-result delivery with the
requested fixed reply and no encrypted child task parts. An encrypted-message
control on that same configured entry point failed to interpret the task.
Another live probe forced the CLI to use HTTP (`supports_websockets=false`)
through the shared compatibility adapter and the configured HTTP upstream. It
completed child-result delivery in four requests, with plaintext child task
parts and no encrypted child task parts.
Support and latency of other upstreams still require a live test.

Implementation reference:
[Codex v0.159.2 tool dispatch](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/tools/router.rs).
