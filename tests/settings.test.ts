import { describe, expect, it } from "vitest";
import {
  DEFAULT_SENTENCE_PROMPT_ID,
  DEFAULT_WORD_PROMPT_ID,
  normalizeSettings,
  resolvePrompt
} from "../src/shared/settings";

describe("settings migration and prompt routing", () => {
  it("migrates legacy word/sentence prompt strings", () => {
    const settings = normalizeSettings({
      prompts: {
        word: "legacy word prompt",
        sentence: "legacy sentence prompt"
      }
    });

    expect(settings.prompts.items).toHaveLength(2);
    expect(resolvePrompt(settings, "word").systemPrompt).toBe("legacy word prompt");
    expect(resolvePrompt(settings, "sentence").systemPrompt).toBe("legacy sentence prompt");
  });

  it("uses MiMo TTS as the default pronunciation provider", () => {
    const settings = normalizeSettings({});
    expect(settings.pronunciation.provider).toBe("mimo");
    expect(settings.pronunciation.mimo.model).toBe("mimo-v2.5-tts");
    expect(settings.pronunciation.mimo.voice).toBe("Mia");
    expect(settings.pronunciation.mimo.style).toContain("British English accent");
  });

  it("keeps an explicitly enabled legacy Youdao setup as the fallback provider", () => {
    const settings = normalizeSettings({
      pronunciation: {
        youdao: {
          enabled: true,
          appKey: "legacy-key",
          appSecret: "legacy-secret"
        }
      }
    });

    expect(settings.pronunciation.provider).toBe("youdao");
    expect(settings.pronunciation.youdao.appKey).toBe("legacy-key");
  });

  it("routes explicit prompts and keeps defaults", () => {
    const settings = normalizeSettings({
      prompts: {
        items: [
          {
            id: "word-a",
            name: "Word A",
            description: "",
            applicableType: "word",
            systemPrompt: "A",
            userTemplate: "{{selection}} {{context}}",
            enabled: true,
            version: 3
          },
          {
            id: "word-b",
            name: "Word B",
            description: "",
            applicableType: "word",
            systemPrompt: "B",
            userTemplate: "{{selection}}",
            enabled: true,
            version: 1
          }
        ],
        defaultWordPromptId: "word-a",
        defaultSentencePromptId: "missing"
      }
    });

    expect(resolvePrompt(settings, "word").id).toBe("word-a");
    expect(resolvePrompt(settings, "word", "word-b").systemPrompt).toBe("B");
    expect(resolvePrompt(normalizeSettings({}), "word").id).toBe(DEFAULT_WORD_PROMPT_ID);
    expect(resolvePrompt(normalizeSettings({}), "sentence").id).toBe(DEFAULT_SENTENCE_PROMPT_ID);
  });
});
