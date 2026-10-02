"use client";

import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { getUsageLogTransport } from "@/lib/utils/usage-log-transport";
import type { ProviderChainItem } from "@/types/message";

export function TransportBadge({ providerChain }: { providerChain?: ProviderChainItem[] | null }) {
  const t = useTranslations("dashboard.logs.transport");
  const transport = getUsageLogTransport(providerChain);
  const label = t(transport ?? "unknown");
  return (
    <Badge
      variant="outline"
      data-upstream-transport={transport ?? "unknown"}
      title={t(transport ? "tooltip" : "unknownTooltip", { transport: label })}
      className={cn(
        "h-4 rounded px-1 py-0 text-[9px] font-mono font-normal",
        transport === "websocket"
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
          : "text-muted-foreground"
      )}
    >
      {label}
    </Badge>
  );
}
