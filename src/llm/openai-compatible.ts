import type { ChatMessage } from "../shared/prompts";

export interface OpenAiCompatibleRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  timeoutMs?: number;
}

export interface LlmConnectionTestResult {
  latencyMs: number;
  preview: string;
}

const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_STREAM_BUFFER_CHARS = 1024 * 1024;
const MAX_STREAM_OUTPUT_CHARS = 200_000;
const MAX_ERROR_BODY_BYTES = 64 * 1024;

export class LlmRequestError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "config"
      | "auth"
      | "quota"
      | "rate_limit"
      | "not_found"
      | "timeout"
      | "network"
      | "protocol"
      | "server"
  ) {
    super(message);
    this.name = "LlmRequestError";
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost"
    || normalized === "127.0.0.1"
    || normalized === "::1"
    || normalized === "[::1]";
}

async function readResponseTextLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    const remaining = maxBytes - total;
    if (remaining <= 0) {
      await reader.cancel();
      break;
    }
    const chunk = result.value.byteLength > remaining
      ? result.value.subarray(0, remaining)
      : result.value;
    total += chunk.byteLength;
    text += decoder.decode(chunk, { stream: true });
    if (chunk.byteLength < result.value.byteLength) {
      await reader.cancel();
      break;
    }
  }
  text += decoder.decode();
  return text;
}

export function buildChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) throw new LlmRequestError("请先配置 API Base URL。", "config");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new LlmRequestError("API Base URL 格式不正确。", "config");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new LlmRequestError("API Base URL 只支持 http 或 https。", "config");
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new LlmRequestError(
      "公网 API 必须使用 HTTPS；仅 localhost、127.0.0.1 或 [::1] 允许使用 HTTP。",
      "config"
    );
  }

  if (/\/chat\/completions$/i.test(url.pathname)) {
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  }
  url.pathname = url.pathname.replace(/\/+$/, "") + "/chat/completions";
  url.hash = "";
  return url.toString();
}

function extractContent(json: unknown): string {
  if (!json || typeof json !== "object") return "";
  const root = json as {
    choices?: Array<{
      delta?: { content?: unknown };
    }>;
  };
  const content = root.choices?.[0]?.delta?.content;
  return typeof content === "string" ? content : "";
}

function extractStreamError(json: unknown): LlmRequestError | null {
  if (!json || typeof json !== "object") return null;
  const raw = (json as { error?: unknown }).error;
  if (!raw) return null;

  const error = typeof raw === "object" && raw
    ? raw as { message?: unknown; code?: unknown; type?: unknown }
    : {};
  const detail = typeof error.message === "string" ? error.message.trim().slice(0, 300) : "";
  const marker = [error.code, error.type]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  const suffix = detail ? `：${detail}` : "";

  if (/auth|unauthor|api.?key|permission|forbidden/.test(marker)) {
    return new LlmRequestError(`模型流返回鉴权错误${suffix}`, "auth");
  }
  if (/rate|thrott/.test(marker)) {
    return new LlmRequestError(`模型流返回限流错误${suffix}`, "rate_limit");
  }
  if (/quota|credit|balance/.test(marker)) {
    return new LlmRequestError(`模型流返回配额错误${suffix}`, "quota");
  }
  if (/server|internal|unavailable/.test(marker)) {
    return new LlmRequestError(`模型流返回服务端错误${suffix}`, "server");
  }
  return new LlmRequestError(`模型流返回错误${suffix}`, "protocol");
}

function mapHttpError(status: number, details: string): LlmRequestError {
  const suffix = details ? `：${details.slice(0, 500)}` : "";
  if (status === 401 || status === 403) {
    return new LlmRequestError(`API Key 无效或没有访问权限${suffix}`, "auth");
  }
  if (status === 402) {
    return new LlmRequestError(`账户余额或配额不足${suffix}`, "quota");
  }
  if (status === 404) {
    return new LlmRequestError(`接口或模型不存在，请检查 Base URL 和模型名${suffix}`, "not_found");
  }
  if (status === 429) {
    return new LlmRequestError(`请求过于频繁或已达到平台限额${suffix}`, "rate_limit");
  }
  if (status >= 500) {
    return new LlmRequestError(`模型服务暂时不可用（HTTP ${status}）${suffix}`, "server");
  }
  return new LlmRequestError(`API 请求失败（HTTP ${status}）${suffix}`, "protocol");
}

function withTimeout(signal: AbortSignal, timeoutMs: number): {
  signal: AbortSignal;
  cleanup: () => void;
  didTimeout: () => boolean;
} {
  const controller = new AbortController();
  let timeout = false;

  const abortFromCaller = () => controller.abort(signal.reason);
  if (signal.aborted) {
    controller.abort(signal.reason);
  } else {
    signal.addEventListener("abort", abortFromCaller, { once: true });
  }

  const timer = setTimeout(() => {
    timeout = true;
    controller.abort(new DOMException("Timed out", "TimeoutError"));
  }, timeoutMs);

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abortFromCaller);
    },
    didTimeout: () => timeout
  };
}

export async function streamOpenAiCompatible(
  request: OpenAiCompatibleRequest,
  signal: AbortSignal,
  onChunk: (text: string) => void
): Promise<void> {
  if (!request.apiKey) throw new LlmRequestError("请先在扩展设置中填写 API Key。", "config");
  if (!request.model) throw new LlmRequestError("请先在扩展设置中填写模型名称。", "config");

  const timeout = withTimeout(signal, request.timeoutMs ?? 45000);

  try {
    let response: Response;
    try {
      response = await fetch(buildChatCompletionsUrl(request.baseUrl), {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${request.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          stream: true
        }),
        signal: timeout.signal
      });
    } catch (error) {
      if (timeout.didTimeout()) {
        throw new LlmRequestError("模型请求超时，请稍后重试或调高超时时间。", "timeout");
      }
      if (signal.aborted) throw error;
      throw new LlmRequestError("无法连接模型服务，请检查网络和 Base URL。", "network");
    }

    if (!response.ok) {
      throw mapHttpError(response.status, await readResponseTextLimited(response, MAX_ERROR_BODY_BYTES));
    }
    if (!response.body) {
      throw new LlmRequestError("API 没有返回可读取的流。", "protocol");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawData = false;
    let responseBytes = 0;
    let outputChars = 0;

    const consumeLine = (line: string): boolean => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return false;

      const data = trimmed.slice(5).trim();
      if (!data) return false;
      if (data === "[DONE]") return true;

      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        // Ignore keepalive records. If the whole stream is incompatible we fail below.
        return false;
      }
      const streamError = extractStreamError(parsed);
      if (streamError) throw streamError;
      const text = extractContent(parsed);
      if (text) {
        outputChars += text.length;
        if (outputChars > MAX_STREAM_OUTPUT_CHARS) {
          throw new LlmRequestError("模型返回内容过大，已为保护浏览器内存中止请求。", "protocol");
        }
        sawData = true;
        onChunk(text);
      }
      return false;
    };

    let sawDone = false;
    while (!sawDone) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        if (timeout.didTimeout()) {
          throw new LlmRequestError("模型响应超时。", "timeout");
        }
        if (signal.aborted) throw error;
        throw new LlmRequestError("读取模型流时网络中断。", "network");
      }
      if (result.done) break;

      responseBytes += result.value.byteLength;
      if (responseBytes > MAX_STREAM_BYTES) {
        throw new LlmRequestError("模型流响应过大，已为保护浏览器内存中止请求。", "protocol");
      }
      buffer += decoder.decode(result.value, { stream: true });
      if (buffer.length > MAX_STREAM_BUFFER_CHARS) {
        throw new LlmRequestError("模型流包含异常大的单条数据，已中止请求。", "protocol");
      }
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
    if (!sawData) {
      throw new LlmRequestError("模型返回了无法识别的流格式。", "protocol");
    }
  } finally {
    timeout.cleanup();
  }
}

export async function testOpenAiCompatibleConnection(
  config: Omit<OpenAiCompatibleRequest, "messages">,
  signal: AbortSignal = new AbortController().signal
): Promise<LlmConnectionTestResult> {
  const startedAt = performance.now();
  let preview = "";

  await streamOpenAiCompatible(
    {
      ...config,
      messages: [
        {
          role: "user",
          content: "This is a connection test. Reply with OK only."
        }
      ]
    },
    signal,
    text => {
      if (preview.length < 160) preview += text;
    }
  );

  return {
    latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    preview: preview.trim().slice(0, 160)
  };
}
