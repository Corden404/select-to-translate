import { describe, expect, it } from "vitest";
import {
  clampLookupPayload,
  isLookupPortRequest,
  LOOKUP_PROTOCOL_LIMITS,
  recoverLookupRequestId
} from "../src/shared/messages";

describe("lookup message protocol", () => {
  const basePayload = {
    selectedText: "detect",
    kind: "word" as const,
    context: {
      currentSentence: "This tool can detect a word in context."
    },
    pageUrl: "https://example.com/path",
    pageTitle: "Example",
    sourceType: "web" as const
  };

  it("uses the same length limits for validation and content-side clamping", () => {
    const payload = clampLookupPayload({
      ...basePayload,
      context: {
        currentSentence: "c".repeat(LOOKUP_PROTOCOL_LIMITS.context + 20),
        previousSentence: "p".repeat(LOOKUP_PROTOCOL_LIMITS.context + 20),
        nextSentence: "n".repeat(LOOKUP_PROTOCOL_LIMITS.context + 20)
      },
      pageUrl: "https://example.com/?" + "x".repeat(LOOKUP_PROTOCOL_LIMITS.pageUrl + 20),
      pageTitle: "t".repeat(LOOKUP_PROTOCOL_LIMITS.pageTitle + 20)
    });

    expect(payload.context.currentSentence).toHaveLength(LOOKUP_PROTOCOL_LIMITS.context);
    expect(payload.context.previousSentence).toHaveLength(LOOKUP_PROTOCOL_LIMITS.context);
    expect(payload.context.nextSentence).toHaveLength(LOOKUP_PROTOCOL_LIMITS.context);
    expect(payload.pageUrl.length).toBeLessThanOrEqual(LOOKUP_PROTOCOL_LIMITS.pageUrl);
    expect(payload.pageTitle).toHaveLength(LOOKUP_PROTOCOL_LIMITS.pageTitle);
    expect(isLookupPortRequest({
      type: "LOOKUP_START",
      requestId: "request-1",
      triggeredAt: Date.now(),
      payload
    })).toBe(true);
  });

  it("rejects overlong lookup and chat requests while retaining a safe request id", () => {
    const invalidLookup = {
      type: "LOOKUP_START",
      requestId: "request-2",
      triggeredAt: Date.now(),
      payload: {
        ...basePayload,
        pageTitle: "x".repeat(LOOKUP_PROTOCOL_LIMITS.pageTitle + 1)
      }
    };
    expect(isLookupPortRequest(invalidLookup)).toBe(false);
    expect(recoverLookupRequestId(invalidLookup)).toBe("request-2");

    expect(isLookupPortRequest({
      type: "LOOKUP_START",
      requestId: "request-invalid-time",
      triggeredAt: Number.NaN,
      payload: basePayload
    })).toBe(false);

    const invalidChat = {
      type: "CHAT_SEND",
      requestId: "request-3",
      message: "x".repeat(LOOKUP_PROTOCOL_LIMITS.chatMessage + 1)
    };
    expect(isLookupPortRequest(invalidChat)).toBe(false);
    expect(recoverLookupRequestId(invalidChat)).toBe("request-3");
  });
});
