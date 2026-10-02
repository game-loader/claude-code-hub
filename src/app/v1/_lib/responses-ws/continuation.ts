import { defaultLocale, type Locale, locales } from "@/i18n/config";

const catalogs = {
  "zh-CN": () => import("../../../../../messages/zh-CN/errors.json"),
  "zh-TW": () => import("../../../../../messages/zh-TW/errors.json"),
  en: () => import("../../../../../messages/en/errors.json"),
  ja: () => import("../../../../../messages/ja/errors.json"),
  ru: () => import("../../../../../messages/ru/errors.json"),
};

export function hasResponsesWsContinuation(body: Record<string, unknown> | null): boolean {
  return typeof body?.previous_response_id === "string" && body.previous_response_id.length > 0;
}

export async function buildResponsesWsContinuationErrorResponse(): Promise<Response> {
  let locale: Locale = defaultLocale;
  try {
    const { getLocale } = await import("next-intl/server");
    const requested = await getLocale();
    if (locales.includes(requested as Locale)) locale = requested as Locale;
  } catch {
    // The proxy entrypoint may run without a locale context.
  }
  const message = (await catalogs[locale]()).default.RESPONSES_WS_CONTINUATION_LOST;
  return Response.json(
    {
      error: {
        type: "invalid_request_error",
        code: "previous_response_not_found",
        param: "previous_response_id",
        message,
      },
    },
    { status: 400 }
  );
}
