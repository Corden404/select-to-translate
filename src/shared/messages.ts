import { countEnglishWords, type SelectionKind } from "./selection";
import type { PublicLookupSettings } from "./settings";

export const LOOKUP_PROTOCOL_LIMITS = {
  requestId: 100,
  promptId: 80,
  selectedText: 4000,
  selectedWords: 30,
  context: 12000,
  pageUrl: 5000,
  pageTitle: 1000,
  chatMessage: 4000
} as const;

export interface LookupContextPayload {
  previousSentence?: string;
  currentSentence: string;
  nextSentence?: string;
  quality?: "exact" | "fallback";
}

export interface LookupRequestPayload {
  selectedText: string;
  kind: SelectionKind;
  context: LookupContextPayload;
  pageUrl: string;
  pageTitle: string;
  sourceType?: "web" | "pdf";
}

export interface SpeechLatencyReport {
  triggerToWorkerMs: number;
  workerPrepMs: number;
  llmTtftMs: number;
  llmGenerationMs: number;
  llmTotalMs: number;
  ttsMs: number;
  ttsHeadersMs: number;
  ttsFirstAudioAfterHeadersMs: number;
  ttsFirstChunkMs: number;
  ttsRemainingStreamMs: number;
  ttsParseMs: number;
  ttsChunkCount: number;
  speechChars: number;
  ttsResponseBytes: number;
  audioBytes: number;
  offscreenReadyMs: number;
  audioStartMs: number;
  totalMs: number;
}

export interface PublicSettingsResponse {
  ok: boolean;
  enabled: boolean;
  settings?: PublicLookupSettings;
  message?: string;
}

export interface PublicSettingsChangedMessage {
  type: "PUBLIC_SETTINGS_CHANGED";
  enabled: boolean;
  settings: PublicLookupSettings;
}

export interface ManualLookupTriggerMessage {
  type: "MANUAL_LOOKUP_TRIGGER";
}

function looksLikePublicSettings(value: unknown): value is PublicLookupSettings {
  if (!value || typeof value !== "object") return false;
  const settings = value as Partial<PublicLookupSettings>;
  const rawSettings = value as Record<string, unknown>;
  return !!settings.ui
    && !("api" in rawSettings)
    && (settings.ui.theme === "dark" || settings.ui.theme === "light" || settings.ui.theme === "system")
    && (settings.ui.fontSize === "small" || settings.ui.fontSize === "medium" || settings.ui.fontSize === "large")
    && !!settings.behavior
    && (settings.behavior.mode === "auto" || settings.behavior.mode === "manual")
    && Array.isArray(settings.behavior.disabledHosts)
    && settings.behavior.disabledHosts.every(host => typeof host === "string")
    && typeof settings.behavior.skipEditable === "boolean"
    && !!settings.pronunciation
    && (settings.pronunciation.provider === "mimo"
      || settings.pronunciation.provider === "youdao"
      || settings.pronunciation.provider === "off")
    && !!settings.pronunciation.mimo
    && !("apiKey" in (settings.pronunciation.mimo as unknown as Record<string, unknown>))
    && typeof settings.pronunciation.mimo.voice === "string"
    && !!settings.speechExplanation
    && typeof settings.speechExplanation.enabled === "boolean"
    && typeof settings.speechExplanation.stopOnCardClose === "boolean"
    && !!settings.prompts
    && Array.isArray(settings.prompts.items)
    && settings.prompts.items.every(item => {
      if (!item || typeof item !== "object") return false;
      const prompt = item as unknown as Record<string, unknown>;
      return !("systemPrompt" in prompt) && !("userTemplate" in prompt);
    })
    && typeof settings.prompts.defaultWordPromptId === "string"
    && typeof settings.prompts.defaultSentencePromptId === "string";
}

export function isPublicSettingsResponse(value: unknown): value is PublicSettingsResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Partial<PublicSettingsResponse>;
  return typeof response.ok === "boolean"
    && typeof response.enabled === "boolean"
    && (response.settings === undefined || looksLikePublicSettings(response.settings));
}

export function isPublicSettingsChangedMessage(value: unknown): value is PublicSettingsChangedMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<PublicSettingsChangedMessage>;
  return message.type === "PUBLIC_SETTINGS_CHANGED"
    && typeof message.enabled === "boolean"
    && looksLikePublicSettings(message.settings);
}

export type LookupPortRequest =
  | {
      type: "LOOKUP_START";
      requestId: string;
      promptId?: string;
      triggeredAt: number;
      payload: LookupRequestPayload;
    }
  | {
      type: "CHAT_SEND";
      requestId: string;
      message: string;
    };

export type LookupPortResponse =
  | { type: "LOOKUP_STARTED"; requestId: string; recordId: string; promptId: string; promptName: string }
  | { type: "LOOKUP_CHUNK"; requestId: string; text: string }
  | { type: "LOOKUP_DONE"; requestId: string }
  | { type: "SPEECH_READY"; requestId: string }
  | { type: "SPEECH_TIMING"; requestId: string; report: SpeechLatencyReport }
  | { type: "CHAT_STARTED"; requestId: string }
  | { type: "CHAT_CHUNK"; requestId: string; text: string }
  | { type: "CHAT_DONE"; requestId: string }
  | { type: "CHAT_ERROR"; requestId: string; message: string }
  | { type: "LOOKUP_ERROR"; requestId: string; message: string };

export type OneShotMessage =
  | { type: "PUBLIC_SETTINGS_GET" }
  | { type: "SPEECH_CANCEL"; requestId: string }
  | { type: "SPEECH_REPLAY"; requestId: string }
  | { type: "PRONUNCIATION_GET"; word: string }
  | {
      type: "TEST_LLM_CONNECTION";
      config: {
        baseUrl: string;
        apiKey: string;
        model: string;
        timeoutMs: number;
      };
    }
  | {
      type: "TEST_PRONUNCIATION_CONNECTION";
      provider: "mimo" | "youdao";
      mimo?: {
        apiKey: string;
        baseUrl: string;
        model: string;
        voice: "Mia" | "Chloe" | "Milo" | "Dean";
        style: string;
      };
      youdao?: {
        appKey: string;
        appSecret: string;
      };
    };

export interface SpeechActionResponse {
  ok: boolean;
  message?: string;
  replayable?: boolean;
}

export interface PronunciationResponse {
  ok: boolean;
  provider?: "mimo" | "youdao";
  phonetic?: string;
  audioDataUrl?: string;
  label?: string;
  message?: string;
}

export interface ConnectionTestResponse {
  ok: boolean;
  latencyMs: number;
  message: string;
  preview?: string;
  provider?: "llm" | "mimo" | "youdao";
}

function validOptionalContext(value: unknown): boolean {
  return value === undefined
    || (typeof value === "string" && value.length <= LOOKUP_PROTOCOL_LIMITS.context);
}

function isSafeSourceUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return ["http:", "https:", "chrome-extension:", "local-pdf:", "about:"].includes(protocol);
  } catch {
    return false;
  }
}

export function isLookupPortRequest(message: unknown): message is LookupPortRequest {
  if (!message || typeof message !== "object") return false;
  const candidate = message as Partial<LookupPortRequest>;
  if (candidate.type === "CHAT_SEND") {
    return typeof candidate.requestId === "string"
      && candidate.requestId.length > 0
      && candidate.requestId.length <= LOOKUP_PROTOCOL_LIMITS.requestId
      && typeof candidate.message === "string"
      && candidate.message.trim().length > 0
      && candidate.message.length <= LOOKUP_PROTOCOL_LIMITS.chatMessage;
  }
  if (candidate.type !== "LOOKUP_START") return false;
  return typeof candidate.requestId === "string"
    && candidate.requestId.length > 0
    && candidate.requestId.length <= LOOKUP_PROTOCOL_LIMITS.requestId
    && typeof candidate.triggeredAt === "number"
    && Number.isFinite(candidate.triggeredAt)
    && candidate.triggeredAt > 0
    && (!candidate.promptId || (
      typeof candidate.promptId === "string"
      && candidate.promptId.length <= LOOKUP_PROTOCOL_LIMITS.promptId
    ))
    && !!candidate.payload
    && typeof candidate.payload.selectedText === "string"
    && candidate.payload.selectedText.length <= LOOKUP_PROTOCOL_LIMITS.selectedText
    && countEnglishWords(candidate.payload.selectedText) >= 1
    && countEnglishWords(candidate.payload.selectedText) <= LOOKUP_PROTOCOL_LIMITS.selectedWords
    && (candidate.payload.kind === "word" || candidate.payload.kind === "sentence")
    && typeof candidate.payload.context?.currentSentence === "string"
    && candidate.payload.context.currentSentence.length <= LOOKUP_PROTOCOL_LIMITS.context
    && validOptionalContext(candidate.payload.context.previousSentence)
    && validOptionalContext(candidate.payload.context.nextSentence)
    && (!candidate.payload.sourceType
      || candidate.payload.sourceType === "web"
      || candidate.payload.sourceType === "pdf")
    && typeof candidate.payload.pageUrl === "string"
    && candidate.payload.pageUrl.length <= LOOKUP_PROTOCOL_LIMITS.pageUrl
    && isSafeSourceUrl(candidate.payload.pageUrl)
    && typeof candidate.payload.pageTitle === "string"
    && candidate.payload.pageTitle.length <= LOOKUP_PROTOCOL_LIMITS.pageTitle;
}

export function recoverLookupRequestId(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const requestId = (message as { requestId?: unknown }).requestId;
  return typeof requestId === "string"
    && requestId.length > 0
    && requestId.length <= LOOKUP_PROTOCOL_LIMITS.requestId
    ? requestId
    : null;
}

function clamp(value: string | undefined, limit: number): string | undefined {
  return typeof value === "string" ? value.slice(0, limit) : undefined;
}

export function clampLookupPayload(payload: LookupRequestPayload): LookupRequestPayload {
  return {
    ...payload,
    context: {
      ...payload.context,
      currentSentence: payload.context.currentSentence.slice(0, LOOKUP_PROTOCOL_LIMITS.context),
      previousSentence: clamp(payload.context.previousSentence, LOOKUP_PROTOCOL_LIMITS.context),
      nextSentence: clamp(payload.context.nextSentence, LOOKUP_PROTOCOL_LIMITS.context)
    },
    pageUrl: payload.pageUrl.slice(0, LOOKUP_PROTOCOL_LIMITS.pageUrl),
    pageTitle: payload.pageTitle.slice(0, LOOKUP_PROTOCOL_LIMITS.pageTitle)
  };
}
