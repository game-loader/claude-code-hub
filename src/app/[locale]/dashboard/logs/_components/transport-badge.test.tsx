import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ProviderChainItem } from "@/types/message";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: { transport: string }) => {
    const labels: Record<string, string> = { websocket: "WS", http: "HTTP", unknown: "Unknown" };
    return labels[key] ?? `upstream ${params?.transport ?? "unknown"}`;
  },
}));

import { TransportBadge } from "./transport-badge";

describe("usage log transport badge", () => {
  it.each(["websocket", "http"] as const)(
    "renders the actual %s protocol and upstream tooltip",
    (upstreamTransport) => {
      const chain: ProviderChainItem[] = [
        { id: 1, name: "p", reason: "request_success", statusCode: 200, upstreamTransport },
      ];
      const html = renderToStaticMarkup(<TransportBadge providerChain={chain} />);
      expect(html).toContain(`data-upstream-transport="${upstreamTransport}"`);
      expect(html).toContain(upstreamTransport === "websocket" ? "WS" : "HTTP");
      expect(html).toContain('title="upstream ');
    }
  );
  it("renders a separate unknown tag for historical or blocked requests", () => {
    const html = renderToStaticMarkup(<TransportBadge providerChain={null} />);
    expect(html).toContain('data-upstream-transport="unknown"');
    expect(html).toContain("Unknown");
    expect(html).not.toContain("HTTP");
  });
});
