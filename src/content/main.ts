import { getSelectionAnchor } from "./anchor";
import { extractContext } from "./context-extractor";
import { FloatingCard, type CardQuery } from "./floating-card";
import type {
  LookupPortResponse,
  LookupRequestPayload,
  PronunciationResponse
} from "../shared/messages";
import { classifySelection } from "../shared/selection";
import {
  AUTO_LOOKUP_STORAGE_KEY,
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  loadLookupSettings,
  normalizeSettings,
  resolvePrompt,
  type LookupSettings
} from "../shared/settings";

let enabled = true;
let scheduled: number | null = null;
let lastFingerprint = "";
let activePort: chrome.runtime.Port | null = null;
let activeRequestId = "";
let settings: LookupSettings = DEFAULT_SETTINGS;

const pronunciationCache = new Map<string, PronunciationResponse>();

const card = new FloatingCard({
  onRegenerate: (query, promptId) => startLookup(query, promptId),
  onPromptChange: (query, promptId) => startLookup(query, promptId),
  onFollowUp: message => sendFollowUp(message),
  onPronounce: word => getPronunciation(word),
  onDismiss: () => cancelActiveRequest()
});

async function loadState(): Promise<void> {
  const [stored, loadedSettings] = await Promise.all([
    chrome.storage.local.get({ [AUTO_LOOKUP_STORAGE_KEY]: true }),
    loadLookupSettings()
  ]);
  enabled = stored[AUTO_LOOKUP_STORAGE_KEY] !== false;
  settings = loadedSettings;
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

  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;

  const classified = classifySelection(selection.toString());
  if (!classified) return;

  const anchor = getSelectionAnchor(selection);
  if (!anchor) return;

  const nextFingerprint = fingerprint(classified.text, anchor.top, anchor.left);
  if (nextFingerprint === lastFingerprint) return;
  lastFingerprint = nextFingerprint;

  cancelActiveRequest();
  const context = extractContext(selection, classified.kind, classified.text);
  const query: CardQuery = { selection: classified, context };
  const prompt = resolvePrompt(settings, classified.kind);
  card.show(query, anchor, settings, prompt.id);
  startLookup(query, prompt.id);

  if (classified.kind === "word" && settings.pronunciation.youdao.enabled) {
    void card.preloadPronunciation();
  }
}

function startLookup(query: CardQuery, promptId?: string): void {
  cancelActiveRequest();

  const requestId = crypto.randomUUID();
  activeRequestId = requestId;
  const port = chrome.runtime.connect({ name: "lookup-stream" });
  activePort = port;
  card.beginLoading();

  const source = getSourceMetadata();
  const payload: LookupRequestPayload = {
    selectedText: query.selection.text,
    kind: query.selection.kind,
    context: query.context,
    pageUrl: source.pageUrl,
    pageTitle: source.pageTitle,
    sourceType: source.sourceType
  };

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
      case "LOOKUP_ERROR":
        card.showError(message.message);
        card.chatDone();
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

function sendFollowUp(message: string): void {
  if (!activePort || !activeRequestId) {
    card.showError("当前会话已经结束，请重新选择文本。");
    return;
  }
  activePort.postMessage({
    type: "CHAT_SEND",
    requestId: activeRequestId,
    message
  });
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

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;

  if (changes[AUTO_LOOKUP_STORAGE_KEY]) {
    enabled = changes[AUTO_LOOKUP_STORAGE_KEY].newValue !== false;
    lastFingerprint = "";
    if (!enabled) card.hide();
  }

  if (changes[SETTINGS_STORAGE_KEY]) {
    settings = normalizeSettings(changes[SETTINGS_STORAGE_KEY].newValue);
    pronunciationCache.clear();
    card.setAppearance(settings.ui);
  }
});

void loadState();
