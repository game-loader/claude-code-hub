import {
  normalizeCodexPlaintextAgentPayload,
  prepareCodexPlaintextAgentTools,
} from "../../../../../server-lib/codex-agent-message-compat.js";
import { RESPONSES_WS_MAX_PAYLOAD_BYTES } from "../../../../../server-lib/responses-ws-limits.js";
import type { ProxySession } from "./session";
import { SegmentedTextBuffer, SseFrameBufferLimitError } from "./stream-gate/sse-frames";

export async function prepareCodexAgentMessageRequest(session: ProxySession): Promise<void> {
  if (
    process.env.CCH_CODEX_PLAINTEXT_AGENT_MESSAGES !== "true" ||
    session.requestUrl.pathname !== "/v1/responses"
  ) {
    return;
  }
  if (prepareCodexPlaintextAgentTools(session.request.message) > 0) {
    await session.syncRequestBodyFromMessage();
  }
}

function rewriteJson(text: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return text;
  }
  return normalizeCodexPlaintextAgentPayload(payload) ? JSON.stringify(payload) : text;
}

function rewriteFrame(frame: string): string {
  const lines = frame.split(/\r\n|\r|\n/);
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  const rewritten = rewriteJson(data);
  if (rewritten === data) return frame;

  // Preserve event/id/retry/comment fields and line endings. Only data changes.
  let written = false;
  return frame.replace(/[^\r\n]+(?:\r\n|\r|\n|$)|\r\n|\r|\n/g, (line) => {
    if (!line.startsWith("data:")) return line;
    if (written) return "";
    written = true;
    const ending = line.match(/(?:\r\n|\r|\n)$/)?.[0] ?? "";
    return `data: ${rewritten}${ending}`;
  });
}

export function normalizeCodexAgentMessageResponse(response: Response): Response {
  if (process.env.CCH_CODEX_PLAINTEXT_AGENT_MESSAGES !== "true" || !response.ok || !response.body) {
    return response;
  }
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const streaming = contentType.includes("text/event-stream");
  if (!streaming && !contentType.includes("application/json") && !contentType.includes("+json")) {
    return response;
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const line = new SegmentedTextBuffer();
  const frame = new SegmentedTextBuffer();
  let pendingCr = false;

  const append = (buffer: SegmentedTextBuffer, text: string) => {
    if (line.length + frame.length + text.length > RESPONSES_WS_MAX_PAYLOAD_BYTES) {
      throw new SseFrameBufferLimitError(RESPONSES_WS_MAX_PAYLOAD_BYTES);
    }
    buffer.append(text);
  };
  const emitLine = (ending: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    const content = line.take();
    append(frame, content + ending);
    if (content.length === 0) controller.enqueue(encoder.encode(rewriteFrame(frame.take())));
  };
  const consume = (text: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    if (!streaming) {
      append(frame, text);
      return;
    }
    let start = 0;
    if (pendingCr && text.length > 0) {
      pendingCr = false;
      if (text[0] === "\n") {
        start = 1;
        // A CR already ended the line. Preserve a following LF without
        // dispatching it as another blank line, even across network chunks.
        if (frame.length > 0) append(frame, "\n");
        else controller.enqueue(encoder.encode("\n"));
      }
    }
    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (char !== "\r" && char !== "\n") continue;
      append(line, text.slice(start, index));
      const ending = char === "\r" && text[index + 1] === "\n" ? "\r\n" : char;
      if (ending === "\r\n") index++;
      pendingCr = ending === "\r" && index === text.length - 1;
      emitLine(ending, controller);
      start = index + 1;
    }
    append(line, text.slice(start));
  };

  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        consume(decoder.decode(chunk, { stream: true }), controller);
      },
      flush(controller) {
        consume(decoder.decode(), controller);
        append(frame, line.take());
        if (frame.length > 0) {
          const text = frame.take();
          controller.enqueue(encoder.encode(streaming ? rewriteFrame(text) : rewriteJson(text)));
        }
      },
    })
  );
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
