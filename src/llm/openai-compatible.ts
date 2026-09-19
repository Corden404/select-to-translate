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

  if (/\/chat\/completions$/i.test(url.pathname)) {
    return url.toString().replace(/\/$/, "");
  }
  return `${trimmed}/chat/completions`;
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
      throw mapHttpError(response.status, await response.text());
    }
    if (!response.body) {
      throw new LlmRequestError("API 没有返回可读取的流。", "protocol");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawData = false;

    const consumeLine = (line: string): boolean => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return false;

      const data = trimmed.slice(5).trim();
      if (!data) return false;
      if (data === "[DONE]") return true;

      try {
        const text = extractContent(JSON.parse(data));
        if (text) {
          sawData = true;
          onChunk(text);
        }
      } catch {
        // Ignore keepalive records. If the whole stream is incompatible we fail below.
      }
      return false;
    };

    while (true) {
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

      buffer += decoder.decode(result.value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (consumeLine(line)) return;
      }
    }

    buffer += decoder.decode();
    if (buffer) consumeLine(buffer);
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
