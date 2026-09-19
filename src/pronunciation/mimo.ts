import type { MimoTtsSettings } from "../shared/settings";
import type { PronunciationProvider, PronunciationResult } from "./types";

export interface MiMoSpeechDiagnostics {
  headersMs: number;
  bodyMs: number;
  parseMs: number;
  totalMs: number;
  inputChars: number;
  responseBytes: number;
  audioBytes: number;
}

export interface MiMoSpeechResult extends PronunciationResult {
  diagnostics: MiMoSpeechDiagnostics;
}

export interface MiMoStreamingSpeechDiagnostics {
  headersMs: number;
  firstAudioAfterHeadersMs: number;
  remainingStreamMs: number;
  parseMs: number;
  totalMs: number;
  inputChars: number;
  responseBytes: number;
  audioBytes: number;
  chunkCount: number;
}

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

function streamingAudioDataFromResponse(root: unknown): string | undefined {
  if (!root || typeof root !== "object") return undefined;
  const value = root as {
    choices?: Array<{
      delta?: {
        audio?: {
          data?: unknown;
        };
      };
    }>;
  };
  const data = value.choices?.[0]?.delta?.audio?.data;
  return typeof data === "string" && data.length > 0 ? data : undefined;
}

function estimateBase64Bytes(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(value.length * 3 / 4) - padding);
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
): Promise<MiMoSpeechResult> {
  const input = text.trim();
  if (!input || input.length > maxLength) {
    throw new Error("当前文本不适合使用 MiMo TTS 合成。");
  }
  if (!config.apiKey) {
    throw new Error("请先在扩展设置中填写 MiMo TTS API Key，或把主模型平台设置为小米 MiMo 以复用其 Key。");
  }

  const timeout = withTimeout(signal, 30000);
  const requestStartedAt = performance.now();
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

    const headersReceivedAt = performance.now();

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

    let responseText: string;
    try {
      responseText = await response.text();
    } catch (error) {
      if (timeout.timedOut()) throw new Error("MiMo TTS 请求超时。");
      if (signal?.aborted) throw error;
      throw new Error("读取 MiMo TTS 响应时网络中断。");
    }
    const bodyCompletedAt = performance.now();

    const parseStartedAt = performance.now();
    let json: unknown;
    try {
      json = JSON.parse(responseText);
    } catch {
      throw new Error("MiMo TTS 返回了无法解析的 JSON。");
    }
    const audioBase64 = audioDataFromResponse(json);
    if (!audioBase64) {
      throw new Error("MiMo TTS 没有返回音频数据。");
    }
    const parseCompletedAt = performance.now();

    return {
      audioDataUrl: `data:audio/wav;base64,${audioBase64}`,
      label,
      diagnostics: {
        headersMs: Math.max(0, headersReceivedAt - requestStartedAt),
        bodyMs: Math.max(0, bodyCompletedAt - headersReceivedAt),
        parseMs: Math.max(0, parseCompletedAt - parseStartedAt),
        totalMs: Math.max(0, parseCompletedAt - requestStartedAt),
        inputChars: input.length,
        responseBytes: new TextEncoder().encode(responseText).byteLength,
        audioBytes: estimateBase64Bytes(audioBase64)
      }
    };
  } finally {
    timeout.cleanup();
  }
}

export function getMiMoPronunciation(
  text: string,
  config: MimoTtsSettings,
  signal?: AbortSignal
): Promise<MiMoSpeechResult> {
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
): Promise<MiMoSpeechResult> {
  return synthesizeMiMoSpeech(
    text,
    config,
    1200,
    `MiMo TTS · ${config.voice} · 自然讲解`,
    signal
  );
}

export async function streamMiMoExplanationSpeech(
  text: string,
  config: MimoTtsSettings,
  onAudioChunk: (audioBase64: string) => void,
  signal?: AbortSignal
): Promise<MiMoStreamingSpeechDiagnostics> {
  const input = text.trim();
  if (!input || input.length > 1200) {
    throw new Error("当前文本不适合使用 MiMo TTS 流式合成。");
  }
  if (!config.apiKey) {
    throw new Error("请先在扩展设置中填写 MiMo TTS API Key，或把主模型平台设置为小米 MiMo 以复用其 Key。");
  }

  const timeout = withTimeout(signal, 30000);
  const requestStartedAt = performance.now();
  try {
    let response: Response;
    try {
      response = await fetch(buildChatCompletionsUrl(config.baseUrl), {
        method: "POST",
        headers: {
          "api-key": config.apiKey,
          "Authorization": `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
          "Accept": "text/event-stream"
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
            format: "pcm16",
            voice: config.voice
          },
          stream: true
        }),
        signal: timeout.signal
      });
    } catch (error) {
      if (timeout.timedOut()) throw new Error("MiMo TTS 流式请求超时。");
      if (signal?.aborted) throw error;
      throw new Error("无法连接 MiMo TTS 流式接口，请检查网络、API Key 和 Base URL。");
    }

    const headersReceivedAt = performance.now();
    if (!response.ok) {
      const details = (await response.text()).slice(0, 500);
      if (response.status === 401 || response.status === 403) {
        throw new Error("MiMo TTS API Key 无效或没有模型访问权限。");
      }
      if (response.status === 429) {
        throw new Error("MiMo TTS 请求过于频繁，请稍后重试。");
      }
      throw new Error(`MiMo TTS 流式请求失败（HTTP ${response.status}）${details ? "：" + details : ""}`);
    }
    if (!response.body) throw new Error("MiMo TTS 流式接口没有返回可读取的响应体。");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let responseBytes = 0;
    let audioBytes = 0;
    let chunkCount = 0;
    let parseMs = 0;
    let firstAudioAt: number | null = null;
    let sawDone = false;

    const consumeLine = (line: string): boolean => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return false;
      const data = trimmed.slice(5).trim();
      if (!data) return false;
      if (data === "[DONE]") return true;

      const parseStartedAt = performance.now();
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        parseMs += performance.now() - parseStartedAt;
        return false;
      }
      const audioBase64 = streamingAudioDataFromResponse(parsed);
      parseMs += performance.now() - parseStartedAt;
      if (!audioBase64) return false;

      if (firstAudioAt === null) firstAudioAt = performance.now();
      chunkCount += 1;
      audioBytes += estimateBase64Bytes(audioBase64);
      onAudioChunk(audioBase64);
      return false;
    };

    while (!sawDone) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        if (timeout.timedOut()) throw new Error("MiMo TTS 流式响应超时。");
        if (signal?.aborted) throw error;
        throw new Error("读取 MiMo TTS 流式响应时网络中断。");
      }
      if (result.done) break;
      responseBytes += result.value.byteLength;
      buffer += decoder.decode(result.value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (consumeLine(line)) {
          sawDone = true;
          break;
        }
      }
    }

    if (!sawDone) {
      buffer += decoder.decode();
      if (buffer) consumeLine(buffer);
    }
    if (firstAudioAt === null || chunkCount === 0) {
      throw new Error("MiMo TTS 流式接口没有返回音频数据。");
    }

    const completedAt = performance.now();
    return {
      headersMs: Math.max(0, headersReceivedAt - requestStartedAt),
      firstAudioAfterHeadersMs: Math.max(0, firstAudioAt - headersReceivedAt),
      remainingStreamMs: Math.max(0, completedAt - firstAudioAt),
      parseMs: Math.max(0, parseMs),
      totalMs: Math.max(0, completedAt - requestStartedAt),
      inputChars: input.length,
      responseBytes,
      audioBytes,
      chunkCount
    };
  } finally {
    timeout.cleanup();
  }
}

export class MiMoPronunciationProvider implements PronunciationProvider {
  constructor(private readonly config: MimoTtsSettings) {}

  getPronunciation(word: string, signal?: AbortSignal): Promise<PronunciationResult> {
    return getMiMoPronunciation(word, this.config, signal);
  }
}
