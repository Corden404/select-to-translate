import type { MimoTtsSettings } from "../shared/settings";
import type { PronunciationProvider, PronunciationResult } from "./types";

function buildChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("请先配置 MiMo TTS Base URL。");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("MiMo TTS Base URL 格式不正确。");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("MiMo TTS Base URL 只支持 http 或 https。");
  }

  return /\/chat\/completions$/i.test(url.pathname)
    ? url.toString().replace(/\/$/, "")
    : trimmed + "/chat/completions";
}

function audioDataFromResponse(root: unknown): string | undefined {
  if (!root || typeof root !== "object") return undefined;
  const value = root as {
    choices?: Array<{
      message?: {
        audio?: {
          data?: unknown;
        };
      };
    }>;
  };
  const data = value.choices?.[0]?.message?.audio?.data;
  return typeof data === "string" && data.length > 0 ? data : undefined;
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  cleanup: () => void;
  timedOut: () => boolean;
} {
  const controller = new AbortController();
  let didTimeout = false;

  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) {
    forwardAbort();
  } else {
    signal?.addEventListener("abort", forwardAbort, { once: true });
  }

  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort(new DOMException("Timed out", "TimeoutError"));
  }, timeoutMs);

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forwardAbort);
    },
    timedOut: () => didTimeout
  };
}

async function synthesizeMiMoSpeech(
  text: string,
  config: MimoTtsSettings,
  maxLength: number,
  label: string,
  signal?: AbortSignal
): Promise<PronunciationResult> {
  const input = text.trim();
  if (!input || input.length > maxLength) {
    throw new Error("当前文本不适合使用 MiMo TTS 合成。");
  }
  if (!config.apiKey) {
    throw new Error("请先在扩展设置中填写 MiMo TTS API Key，或把主模型平台设置为小米 MiMo 以复用其 Key。");
  }

  const timeout = withTimeout(signal, 30000);
  try {
    let response: Response;
    try {
      response = await fetch(buildChatCompletionsUrl(config.baseUrl), {
        method: "POST",
        headers: {
          "api-key": config.apiKey,
          "Authorization": `Bearer ${config.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            ...(config.style.trim()
              ? [{ role: "user", content: config.style.trim() }]
              : []),
            { role: "assistant", content: input }
          ],
          audio: {
            format: "wav",
            voice: config.voice
          }
        }),
        signal: timeout.signal
      });
    } catch (error) {
      if (timeout.timedOut()) {
        throw new Error("MiMo TTS 请求超时。");
      }
      if (signal?.aborted) throw error;
      throw new Error("无法连接 MiMo TTS，请检查网络、API Key 和 Base URL。");
    }

    if (!response.ok) {
      const details = (await response.text()).slice(0, 500);
      if (response.status === 401 || response.status === 403) {
        throw new Error("MiMo TTS API Key 无效或没有模型访问权限。");
      }
      if (response.status === 429) {
        throw new Error("MiMo TTS 请求过于频繁，请稍后重试。");
      }
      throw new Error(
        `MiMo TTS 请求失败（HTTP ${response.status}）${details ? "：" + details : ""}`
      );
    }

    const json = await response.json();
    const audioBase64 = audioDataFromResponse(json);
    if (!audioBase64) {
      throw new Error("MiMo TTS 没有返回音频数据。");
    }

    return {
      audioDataUrl: `data:audio/wav;base64,${audioBase64}`,
      label
    };
  } finally {
    timeout.cleanup();
  }
}

export function getMiMoPronunciation(
  text: string,
  config: MimoTtsSettings,
  signal?: AbortSignal
): Promise<PronunciationResult> {
  return synthesizeMiMoSpeech(
    text,
    config,
    160,
    `MiMo TTS · ${config.voice} · 英式风格`,
    signal
  );
}

export function getMiMoExplanationSpeech(
  text: string,
  config: MimoTtsSettings,
  signal?: AbortSignal
): Promise<PronunciationResult> {
  return synthesizeMiMoSpeech(
    text,
    config,
    1200,
    `MiMo TTS · ${config.voice} · 自然讲解`,
    signal
  );
}

export class MiMoPronunciationProvider implements PronunciationProvider {
  constructor(private readonly config: MimoTtsSettings) {}

  getPronunciation(word: string, signal?: AbortSignal): Promise<PronunciationResult> {
    return getMiMoPronunciation(word, this.config, signal);
  }
}
