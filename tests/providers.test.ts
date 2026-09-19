import { describe, expect, it } from "vitest";
import { buildChatCompletionsUrl, streamOpenAiCompatible } from "../src/llm/openai-compatible";
import {
  DEFAULT_SETTINGS,
  DEFAULT_WORD_PROMPT,
  PROVIDER_PRESETS,
  normalizeSettings
} from "../src/shared/settings";

describe("OpenAI-compatible provider config", () => {
  it("appends the chat completions path", () => {
    expect(buildChatCompletionsUrl("https://api.deepseek.com"))
      .toBe("https://api.deepseek.com/chat/completions");
    expect(buildChatCompletionsUrl("https://api.xiaomimimo.com/v1/"))
      .toBe("https://api.xiaomimimo.com/v1/chat/completions");
  });

  it("parses OpenAI-compatible SSE chunks", async () => {
    const originalFetch = globalThis.fetch;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"你"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"好"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    });

    globalThis.fetch = async () => new Response(stream, { status: 200 });
    const chunks: string[] = [];

    try {
      await streamOpenAiCompatible(
        {
          baseUrl: "https://example.com/v1",
          apiKey: "test-key",
          model: "test-model",
          messages: [{ role: "user", content: "hello" }]
        },
        new AbortController().signal,
        chunk => chunks.push(chunk)
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(chunks.join("")).toBe("你好");
  });

  it("does not append the path twice", () => {
    expect(buildChatCompletionsUrl("https://example.com/v1/chat/completions"))
      .toBe("https://example.com/v1/chat/completions");
  });

  it("ships verified provider presets", () => {
    expect(PROVIDER_PRESETS.deepseek.baseUrl).toBe("https://api.deepseek.com");
    expect(PROVIDER_PRESETS.zhipu.baseUrl).toBe("https://open.bigmodel.cn/api/paas/v4");
    expect(PROVIDER_PRESETS.mimo.baseUrl).toBe("https://api.xiaomimimo.com/v1");
    expect(PROVIDER_PRESETS.qwen.baseUrl).toContain("dashscope.aliyuncs.com");
  });

  it("uses dark mode by default", () => {
    expect(DEFAULT_SETTINGS.ui.theme).toBe("dark");
  });

  it("keeps the contextual English explanation requirement in the default word prompt", () => {
    expect(DEFAULT_WORD_PROMPT).toContain("语境英文释义");
    expect(DEFAULT_WORD_PROMPT).toContain("MUST be written in English");
  });

  it("normalizes partial settings without losing defaults", () => {
    const settings = normalizeSettings({
      api: { provider: "mimo", apiKey: "test-key" },
      ui: { fontSize: "large" }
    });

    expect(settings.api.provider).toBe("mimo");
    expect(settings.api.apiKey).toBe("test-key");
    expect(settings.api.baseUrl).toBe(PROVIDER_PRESETS.mimo.baseUrl);
    expect(settings.ui.fontSize).toBe("large");
    expect(settings.ui.theme).toBe("dark");
  });
});
