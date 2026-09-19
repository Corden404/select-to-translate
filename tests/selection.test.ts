import { describe, expect, it } from "vitest";
import {
  classifySelection,
  countEnglishWords,
  isEnglishSelection,
  normalizeSelectionText
} from "../src/shared/selection";

describe("selection helpers", () => {
  it("normalizes whitespace", () => {
    expect(normalizeSelectionText("  hello\n   world  ")).toBe("hello world");
  });

  it("counts English lexical words", () => {
    expect(countEnglishWords("don't re-enter the room")).toBe(4);
  });

  it("rejects non-English selections", () => {
    expect(isEnglishSelection("这是中文")).toBe(false);
  });

  it("classifies one word as word", () => {
    expect(classifySelection("ubiquitous")?.kind).toBe("word");
  });

  it("classifies a short phrase as word mode", () => {
    expect(classifySelection("take for granted")?.kind).toBe("word");
  });

  it("classifies a full sentence as sentence", () => {
    expect(classifySelection("This is a complete sentence.")?.kind).toBe("sentence");
  });

  it("rejects selections above 30 English words", () => {
    const text = Array.from({ length: 31 }, (_, index) => `word${index}`).join(" ");
    expect(classifySelection(text)).toBeNull();
  });
});
