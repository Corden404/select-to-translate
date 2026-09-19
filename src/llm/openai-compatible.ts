import type { ChatMessage } from "../shared/prompts";

export interface OpenAiCompatibleRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
}

export function buildChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("请先配置 API Base URL。");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("API Base URL 格式不正确。");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("API Base URL 只支持 http 或 https。");
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

export async function streamOpenAiCompatible(
  request: OpenAiCompatibleRequest,
  signal: AbortSignal,
  onChunk: (text: string) => void
): Promise<void> {
  if (!request.apiKey) throw new Error("请先在扩展设置中填写 API Key。");
  if (!request.model) throw new Error("请先在扩展设置中填写模型名称。");

  const response = await fetch(buildChatCompletionsUrl(request.baseUrl), {
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
    signal
  });

  if (!response.ok) {
    const details = (await response.text()).slice(0, 600);
    throw new Error(`API 请求失败（HTTP ${response.status}）${details ? `：${details}` : ""}`);
  }

  if (!response.body) {
    throw new Error("API 没有返回可读取的流。");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const consumeLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return false;

    const data = trimmed.slice(5).trim();
    if (!data) return false;
    if (data === "[DONE]") return true;

    try {
      const text = extractContent(JSON.parse(data));
      if (text) onChunk(text);
    } catch {
      // Ignore keepalive or non-JSON SSE records from compatible providers.
    }

    return false;
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (consumeLine(line)) return;
    }
  }

  buffer += decoder.decode();
  if (buffer) consumeLine(buffer);
}
