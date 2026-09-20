import { getSelectionAnchor } from "./anchor";
import { extractContext } from "./context-extractor";
import { FloatingCard, type CardQuery } from "./floating-card";
import type {
  LookupPortResponse,
  LookupRequestPayload,
  PronunciationResponse,
  SpeechActionResponse
} from "../shared/messages";
import {
  clampLookupPayload,
  isPublicSettingsChangedMessage,
  isPublicSettingsResponse,
  LOOKUP_PROTOCOL_LIMITS
} from "../shared/messages";
import { classifySelection } from "../shared/selection";
import {
  DEFAULT_PUBLIC_SETTINGS,
  resolvePublicPrompt,
  type PublicLookupSettings
} from "../shared/settings";

let enabled = true;
let scheduled: number | null = null;
let scheduledTriggeredAt = 0;
let scheduledSelectionText = "";
let lastFingerprint = "";
let suppressLookupUntil = 0;
let activePort: chrome.runtime.Port | null = null;
let activeRequestId = "";
let lastLookupRequestId = "";
let settings: PublicLookupSettings = DEFAULT_PUBLIC_SETTINGS;

const PRONUNCIATION_CACHE_MAX_ENTRIES = 32;
const PRONUNCIATION_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const pronunciationCache = new Map<string, PronunciationResponse>();
let pronunciationCacheBytes = 0;

function pronunciationResponseBytes(response: PronunciationResponse): number {
  return response.audioDataUrl?.length ?? 0;
}

function clearPronunciationCache(): void {
  pronunciationCache.clear();
  pronunciationCacheBytes = 0;
}

function cachePronunciation(key: string, response: PronunciationResponse): void {
  const bytes = pronunciationResponseBytes(response);
  if (bytes > PRONUNCIATION_CACHE_MAX_BYTES) return;
  const previous = pronunciationCache.get(key);
  if (previous) {
    pronunciationCacheBytes -= pronunciationResponseBytes(previous);
    pronunciationCache.delete(key);
  }
  while (
    pronunciationCache.size >= PRONUNCIATION_CACHE_MAX_ENTRIES
    || pronunciationCacheBytes + bytes > PRONUNCIATION_CACHE_MAX_BYTES
  ) {
    const oldest = pronunciationCache.keys().next().value as string | undefined;
    if (!oldest) break;
    const evicted = pronunciationCache.get(oldest);
    if (evicted) pronunciationCacheBytes -= pronunciationResponseBytes(evicted);
    pronunciationCache.delete(oldest);
  }
  pronunciationCache.set(key, response);
  pronunciationCacheBytes += bytes;
}

const card = new FloatingCard({
  onRegenerate: (query, promptId) => startLookup(query, promptId),
  onPromptChange: (query, promptId) => startLookup(query, promptId),
  onKindChange: (query, promptId) => startLookup(query, promptId),
  onFollowUp: message => sendFollowUp(message),
  onPronounce: word => getPronunciation(word),
  onReplaySpeech: () => replaySpeechExplanation(),
  onDismiss: () => {
    lastFingerprint = "";
    suppressLookupUntil = performance.now() + 180;
    const requestId = lastLookupRequestId;
    if (requestId && settings.speechExplanation.enabled && settings.speechExplanation.stopOnCardClose) {
      void chrome.runtime.sendMessage({
        type: "SPEECH_CANCEL",
        requestId
      }).catch(() => undefined);
    }
    lastLookupRequestId = "";
    cancelActiveRequest();
  }
});

async function loadState(): Promise<void> {
  const response = await chrome.runtime.sendMessage({
    type: "PUBLIC_SETTINGS_GET"
  });
  if (!isPublicSettingsResponse(response) || !response.ok || !response.settings) {
    enabled = false;
    return;
  }
  enabled = response.enabled;
  settings = response.settings;
  card.setAppearance(settings.ui);
  if (!enabled) card.hide();
}

function fingerprint(text: string, anchorTop: number, anchorLeft: number): string {
  return `${text}\u0000${Math.round(anchorTop)}\u0000${Math.round(anchorLeft)}`;
}

function cancelActiveRequest(): void {
  if (activePort) {
    activePort.disconnect();
    activePort = null;
  }
  activeRequestId = "";
}

function pointerMatchesSelection(event: Event, selection: Selection): boolean {
  if (event.type !== "pointerup") return true;
  if (selection.rangeCount === 0) return false;
  const target = event.target instanceof Element
    ? event.target
    : event.target instanceof Node
      ? event.target.parentElement
      : null;
  if (!target) return false;
  const range = selection.getRangeAt(0);
  const startElement = range.startContainer.nodeType === Node.ELEMENT_NODE
    ? range.startContainer as Element
    : range.startContainer.parentElement;
  const endElement = range.endContainer.nodeType === Node.ELEMENT_NODE
    ? range.endContainer as Element
    : range.endContainer.parentElement;
  return target === startElement
    || target === endElement
    || Boolean(startElement?.contains(target))
    || Boolean(endElement?.contains(target));
}

function currentSourceHostname(): string {
  const rawUrl = document.documentElement.dataset.lookupSourceUrl || location.href;
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.hostname.toLowerCase() : "";
  } catch {
    return "";
  }
}

function autoLookupAllowedOnPage(): boolean {
  if (settings.behavior.mode !== "auto") return false;
  const host = currentSourceHostname();
  return !host || !settings.behavior.disabledHosts.includes(host);
}

function eventTargetsEditable(event: Event): boolean {
  if (!settings.behavior.skipEditable) return false;
  return event.composedPath().some(target => {
    if (!(target instanceof Element)) return false;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true;
    return target instanceof HTMLElement && target.isContentEditable;
  });
}

function scheduleLookup(event?: Event): void {
  if (!enabled || !autoLookupAllowedOnPage()) return;
  if (event && !event.isTrusted) return;
  if (event && (card.containsEvent(event) || eventTargetsEditable(event))) return;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
  if (event && !pointerMatchesSelection(event, selection)) return;
  scheduledTriggeredAt = Date.now();
  scheduledSelectionText = selection.toString();
  if (scheduled !== null) window.clearTimeout(scheduled);
  scheduled = window.setTimeout(() => runLookup(), 70);
}

function getSourceMetadata(): {
  pageUrl: string;
  pageTitle: string;
  sourceType: "web" | "pdf";
} {
  const root = document.documentElement.dataset;
  return {
    pageUrl: root.lookupSourceUrl || location.href,
    pageTitle: root.lookupSourceTitle || document.title,
    sourceType: root.lookupSourceType === "pdf" ? "pdf" : "web"
  };
}

function runLookup(triggeredAtOverride?: number, force = false): void {
  const triggeredAt = triggeredAtOverride ?? (scheduledTriggeredAt || Date.now());
  const expectedSelectionText = scheduledSelectionText;
  scheduledTriggeredAt = 0;
  scheduledSelectionText = "";
  scheduled = null;
  if (!enabled) return;
  if (!force && performance.now() < suppressLookupUntil) return;

  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
  if (expectedSelectionText && selection.toString() !== expectedSelectionText) return;

  const classified = classifySelection(selection.toString());
  if (!classified) return;
  if (classified.text.length > LOOKUP_PROTOCOL_LIMITS.selectedText) return;

  const anchor = getSelectionAnchor(selection);
  if (!anchor) return;

  const nextFingerprint = fingerprint(classified.text, anchor.top, anchor.left);
  if (!force && nextFingerprint === lastFingerprint) return;
  lastFingerprint = nextFingerprint;

  cancelActiveRequest();
  const sentenceContext = extractContext(selection, "sentence", classified.text);
  const context = classified.kind === "sentence"
    ? sentenceContext
    : {
        currentSentence: sentenceContext.currentSentence,
        quality: sentenceContext.quality
      };
  const query: CardQuery = { selection: classified, context, sentenceContext };
  const prompt = resolvePublicPrompt(settings, classified.kind);
  card.show(query, anchor, settings, prompt.id);
  startLookup(query, prompt.id, triggeredAt);

}

function startLookup(query: CardQuery, promptId?: string, triggeredAt = Date.now()): void {
  cancelActiveRequest();

  const requestId = crypto.randomUUID();
  activeRequestId = requestId;
  lastLookupRequestId = requestId;
  const port = chrome.runtime.connect({ name: "lookup-stream" });
  activePort = port;
  card.beginLoading();

  const source = getSourceMetadata();
  const payload = clampLookupPayload({
    selectedText: query.selection.text,
    kind: query.selection.kind,
    context: query.context,
    pageUrl: source.pageUrl,
    pageTitle: source.pageTitle,
    sourceType: source.sourceType
  } satisfies LookupRequestPayload);

  port.onMessage.addListener((message: LookupPortResponse) => {
    if (message.requestId !== activeRequestId) return;

    switch (message.type) {
      case "LOOKUP_STARTED":
        card.setActivePrompt(message.promptId);
        break;
      case "LOOKUP_CHUNK":
        card.appendChunk(message.text);
        break;
      case "LOOKUP_DONE":
        card.complete();
        break;
      case "SPEECH_READY":
        card.setSpeechReplayReady(true);
        break;
      case "SPEECH_TIMING":
        card.setSpeechLatency(message.report);
        break;
      case "CHAT_STARTED":
        card.chatStarted();
        break;
      case "CHAT_CHUNK":
        card.appendChatChunk(message.text);
        break;
      case "CHAT_DONE":
        card.chatDone();
        break;
      case "CHAT_ERROR":
        card.chatError(message.message);
        break;
      case "LOOKUP_ERROR":
        card.showError(message.message);
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    if (activePort === port) {
      activePort = null;
      activeRequestId = "";
    }
  });

  port.postMessage({
    type: "LOOKUP_START",
    requestId,
    promptId,
    triggeredAt,
    payload
  });
}

function sendFollowUp(message: string): boolean {
  if (!activePort || !activeRequestId) {
    return false;
  }
  activePort.postMessage({
    type: "CHAT_SEND",
    requestId: activeRequestId,
    message
  });
  return true;
}

function triggerManualLookup(): void {
  if (!enabled) return;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
  if (scheduled !== null) window.clearTimeout(scheduled);
  scheduled = null;
  scheduledSelectionText = selection.toString();
  scheduledTriggeredAt = Date.now();
  lastFingerprint = "";
  runLookup(scheduledTriggeredAt, true);
}

async function getPronunciation(word: string): Promise<PronunciationResponse> {
  const key = word.trim().toLowerCase();
  const cached = pronunciationCache.get(key);
  if (cached) {
    pronunciationCache.delete(key);
    pronunciationCache.set(key, cached);
    return cached;
  }

  const response = await chrome.runtime.sendMessage({
    type: "PRONUNCIATION_GET",
    word
  }) as PronunciationResponse;

  if (response?.ok) cachePronunciation(key, response);
  return response ?? { ok: false, message: "发音服务没有响应。" };
}

async function replaySpeechExplanation(): Promise<SpeechActionResponse> {
  const requestId = lastLookupRequestId;
  if (!requestId) return { ok: false, message: "当前没有可重听的语音解释。" };

  const response = await chrome.runtime.sendMessage({
    type: "SPEECH_REPLAY",
    requestId
  }) as SpeechActionResponse;
  return response ?? { ok: false, message: "语音解释重听服务没有响应。" };
}

document.addEventListener("pointerdown", event => {
  if (!event.isTrusted) return;
  card.handleOutsidePointerDown(event);
}, true);

document.addEventListener("pointerup", scheduleLookup, true);
document.addEventListener("keyup", event => {
  if (
    event.key === "Shift" ||
    event.key.startsWith("Arrow") ||
    event.key === "Home" ||
    event.key === "End"
  ) {
    scheduleLookup(event);
  }
}, true);

window.addEventListener("resize", () => card.reposition());
window.addEventListener("scroll", event => card.handleDocumentScroll(event), true);

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (message && typeof message === "object"
    && (message as { type?: unknown }).type === "MANUAL_LOOKUP_TRIGGER") {
    triggerManualLookup();
    return;
  }
  if (!isPublicSettingsChangedMessage(message)) return;
  enabled = message.enabled;
  settings = message.settings;
  lastFingerprint = "";
  clearPronunciationCache();
  card.setAppearance(settings.ui);
  if (!enabled) card.hide();
});

void loadState().catch(() => {
  enabled = false;
});
