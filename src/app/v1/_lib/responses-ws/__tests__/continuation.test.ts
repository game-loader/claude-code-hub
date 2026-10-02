import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultLocale, locales } from "@/i18n/config";
import {
  buildResponsesWsContinuationErrorResponse,
  hasResponsesWsContinuation,
} from "../continuation";

const mocks = vi.hoisted(() => ({ getLocale: vi.fn() }));
vi.mock("next-intl/server", () => ({ getLocale: mocks.getLocale }));

beforeEach(() => {
  mocks.getLocale.mockResolvedValue("en");
});

describe("Responses WS continuation recovery", () => {
  it.each([
    null,
    {},
    { previous_response_id: null },
    { previous_response_id: "" },
    { previous_response_id: 12 },
  ])("accepts full-context requests without a usable previous response: %s", (body) =>
    expect(hasResponsesWsContinuation(body)).toBe(false)
  );

  it("identifies a continuation without changing its incremental input", () => {
    const body = { previous_response_id: "resp_previous", input: ["only new items"] };
    expect(hasResponsesWsContinuation(body)).toBe(true);
    expect(body).toEqual({ previous_response_id: "resp_previous", input: ["only new items"] });
  });

  it.each(locales)(
    "returns a localized recovery error with the stable protocol code in %s",
    async (locale) => {
      mocks.getLocale.mockResolvedValue(locale);
      const response = await buildResponsesWsContinuationErrorResponse();
      const catalog = await import(`../../../../../../messages/${locale}/errors.json`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: {
          type: "invalid_request_error",
          code: "previous_response_not_found",
          param: "previous_response_id",
          message: catalog.default.RESPONSES_WS_CONTINUATION_LOST,
        },
      });
    }
  );

  it.each(["unknown-locale", "no-context"])(
    "uses the default catalog when locale is %s",
    async (reason) => {
      if (reason === "no-context")
        mocks.getLocale.mockRejectedValue(new Error("no locale context"));
      else mocks.getLocale.mockResolvedValue("unknown-locale");
      const catalog = await import(`../../../../../../messages/${defaultLocale}/errors.json`);
      const response = await buildResponsesWsContinuationErrorResponse();
      expect((await response.json()).error.message).toBe(
        catalog.default.RESPONSES_WS_CONTINUATION_LOST
      );
    }
  );
});
