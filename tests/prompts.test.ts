import { describe, expect, it } from "vitest";
import { buildLookupMessages } from "../src/shared/prompts";
import { DEFAULT_SETTINGS } from "../src/shared/settings";

describe("lookup prompt construction", () => {
  it("marks page context as untrusted for word lookup", () => {
    const { messages } = buildLookupMessages(DEFAULT_SETTINGS, {
      selectedText: "detect",
      kind: "word",
      context: {
        currentSentence: "This tool can detect suspicious behavior."
      },
      pageUrl: "https://example.com",
      pageTitle: "Example"
    });

    expect(messages[1].content).toContain("[UNTRUSTED READING CONTEXT]");
    expect(messages[1].content).toContain("This tool can detect suspicious behavior.");
    expect(messages[1].content).toContain("[SELECTED TEXT]");
    expect(messages[1].content).toContain("detect");
  });

  it("includes surrounding sentences for sentence lookup", () => {
    const { messages } = buildLookupMessages(DEFAULT_SETTINGS, {
      selectedText: "This is the selected sentence.",
      kind: "sentence",
      context: {
        previousSentence: "Before.",
        currentSentence: "This is the selected sentence.",
        nextSentence: "After."
      },
      pageUrl: "https://example.com",
      pageTitle: "Example"
    });

    expect(messages[1].content).toContain("Before.");
    expect(messages[1].content).toContain("After.");
  });
});
