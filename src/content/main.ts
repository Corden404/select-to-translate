import { getSelectionAnchor } from "./anchor";
import { extractContext } from "./context-extractor";
import { FloatingCard, type CardQuery } from "./floating-card";
import type {
  LookupPortResponse,
  LookupRequestPayload,
  PronunciationResponse
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
let lastFingerprint = "";
let suppressLookupUntil = 0;
let activePort: chrome.runtime.Port | null = null;
let activeRequestId = "";
let settings: PublicLookupSettings = DEFAULT_PUBLIC_SETTINGS;

const pronunciationCache = new Map<string, PronunciationResponse>();

const card = new FloatingCard({
  onRegenerate: (query, promptId) => startLookup(query, promptId),
  onPromptChange: (query, promptId) => startLookup(query, promptId),
  onKindChange: (query, promptId) => startLookup(query, promptId),
  onFollowUp: message => sendFollowUp(message),
  onPronounce: word => getPronunciation(word),
  onDismiss: () => {
    lastFingerprint = "";
    suppressLookupUntil = performance.now() + 180;
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

function scheduleLookup(event?: Event): void {
  if (!enabled) return;
  if (event && card.containsEvent(event)) return;
  if (scheduled !== null) window.clearTimeout(scheduled);
  scheduled = window.setTimeout(runLookup, 70);
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

function runLookup(): void {
  scheduled = null;
  if (!enabled) return;
  if (performance.now() < suppressLookupUntil) return;

  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;

  const classified = classifySelection(selection.toString());
  if (!classified) return;
  if (classified.text.length > LOOKUP_PROTOCOL_LIMITS.selectedText) return;

  const anchor = getSelectionAnchor(selection);
  if (!anchor) return;

  const nextFingerprint = fingerprint(classified.text, anchor.top, anchor.left);
  if (nextFingerprint === lastFingerprint) return;
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
  startLookup(query, prompt.id);

}

function startLookup(query: CardQuery, promptId?: string): void {
  cancelActiveRequest();

  const requestId = crypto.randomUUID();
  activeRequestId = requestId;
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

async function getPronunciation(word: string): Promise<PronunciationResponse> {
  const key = word.trim().toLowerCase();
  const cached = pronunciationCache.get(key);
  if (cached) return cached;

  const response = await chrome.runtime.sendMessage({
    type: "PRONUNCIATION_GET",
    word
  }) as PronunciationResponse;

  if (response?.ok) pronunciationCache.set(key, response);
  return response ?? { ok: false, message: "发音服务没有响应。" };
}

document.addEventListener("pointerdown", event => {
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
window.addEventListener("scroll", () => card.reposition(), true);

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!isPublicSettingsChangedMessage(message)) return;
  enabled = message.enabled;
  settings = message.settings;
  lastFingerprint = "";
  pronunciationCache.clear();
  card.setAppearance(settings.ui);
  if (!enabled) card.hide();
});

void loadState().catch(() => {
  enabled = false;
});
