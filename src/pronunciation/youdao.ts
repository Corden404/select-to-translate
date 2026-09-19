import type { YoudaoSettings } from "../shared/settings";
import type { PronunciationProvider, PronunciationResult } from "./types";

function truncateForSign(input: string): string {
  if (input.length <= 20) return input;
  return `${input.slice(0, 10)}${input.length}${input.slice(-10)}`;
}

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

function findBasic(root: unknown): { ukPhonetic?: string } | null {
  if (!root || typeof root !== "object") return null;
  const value = root as {
    basic?: { ukPhonetic?: unknown };
    result?: Array<{ basic?: { ukPhonetic?: unknown } }>;
  };

  const basic = value.basic ?? value.result?.find(item => item?.basic)?.basic;
  if (!basic) return null;
  return {
    ukPhonetic: typeof basic.ukPhonetic === "string" ? basic.ukPhonetic : undefined
  };
}

export async function getYoudaoPronunciation(
  word: string,
  config: YoudaoSettings,
  signal?: AbortSignal
): Promise<PronunciationResult> {
  if (!config.enabled) throw new Error("有道英音尚未启用。");
  if (!config.appKey || !config.appSecret) {
    throw new Error("请先在扩展设置中填写有道应用 ID 和应用密钥。");
  }

  const q = word.trim();
  if (!q || q.length > 100) throw new Error("当前选区不适合查询发音。");

  const salt = crypto.randomUUID();
  const curtime = Math.floor(Date.now() / 1000).toString();
  const sign = await sha256Hex(
    config.appKey + truncateForSign(q) + salt + curtime + config.appSecret
  );

  const body = new URLSearchParams({
    q,
    langType: "auto",
    appKey: config.appKey,
    dicts: "ec",
    salt,
    sign,
    signType: "v3",
    curtime,
    docType: "json"
  });

  const response = await fetch("https://openapi.youdao.com/v2/dict", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body,
    signal
  });

  if (!response.ok) {
    throw new Error(`有道词典请求失败（HTTP ${response.status}）。`);
  }

  const json = await response.json() as { errorCode?: unknown; msg?: unknown };
  if (String(json.errorCode ?? "0") !== "0") {
    throw new Error(`有道词典返回错误 ${String(json.errorCode)}：${String(json.msg ?? "")}`);
  }

  const basic = findBasic(json);
  if (!basic) throw new Error("有道词典没有返回英式发音信息。");

  return {
    phonetic: basic.ukPhonetic,
    label: "有道词典 · 英式音标"
  };
}

export class YoudaoPronunciationProvider implements PronunciationProvider {
  constructor(private readonly config: YoudaoSettings) {}

  getPronunciation(word: string, signal?: AbortSignal): Promise<PronunciationResult> {
    return getYoudaoPronunciation(word, this.config, signal);
  }
}
