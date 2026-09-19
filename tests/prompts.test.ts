import { describe, expect, it } from "vitest";
import { buildLookupMessages, renderUserTemplate } from "../src/shared/prompts";
import { DEFAULT_PROMPTS, DEFAULT_SETTINGS } from "../src/shared/settings";

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

  it("expands only placeholders present in the original template", () => {
    const rendered = renderUserTemplate({
      ...DEFAULT_PROMPTS[0],
      userTemplate: "CTX={{context}}\nSEL={{selection}}"
    }, {
      selectedText: "detect {{pageTitle}}",
      kind: "word",
      context: {
        currentSentence: "Context contains {{pageUrl}} and {{selection}}."
      },
      pageUrl: "https://secret.example/path",
      pageTitle: "Sensitive title"
    });

    expect(rendered).toContain("Context contains {{pageUrl}} and {{selection}}.");
    expect(rendered).toContain("detect {{pageTitle}}");
    expect(rendered).not.toContain("https://secret.example/path");
    expect(rendered).not.toContain("Sensitive title");
  });
});
