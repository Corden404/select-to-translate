import { getSelectionAnchor } from "./anchor";
import { extractContext } from "./context-extractor";
import { FloatingCard, type CardQuery } from "./floating-card";
import type { LookupPortResponse, LookupRequestPayload } from "../shared/messages";
import { classifySelection } from "../shared/selection";
import {
  AUTO_LOOKUP_STORAGE_KEY,
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  loadLookupSettings,
  normalizeSettings,
  type LookupSettings
} from "../shared/settings";

let enabled = true;
let scheduled: number | null = null;
let lastFingerprint = "";
let activePort: chrome.runtime.Port | null = null;
let activeRequestId = "";
let settings: LookupSettings = DEFAULT_SETTINGS;

const card = new FloatingCard({
  onRegenerate: query => startLookup(query),
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
  scheduled = window.setTimeout(runLookup, 90);
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
  card.show(query, anchor);
  startLookup(query);
}

function startLookup(query: CardQuery): void {
  cancelActiveRequest();

  const requestId = crypto.randomUUID();
  activeRequestId = requestId;
  const port = chrome.runtime.connect({ name: "lookup-stream" });
  activePort = port;
  card.beginLoading();

  const payload: LookupRequestPayload = {
    selectedText: query.selection.text,
    kind: query.selection.kind,
    context: query.context,
    pageUrl: location.href,
    pageTitle: document.title
  };

  port.onMessage.addListener((message: LookupPortResponse) => {
    if (message.requestId !== activeRequestId) return;

    switch (message.type) {
      case "LOOKUP_STARTED":
        break;
      case "LOOKUP_CHUNK":
        card.appendChunk(message.text);
        break;
      case "LOOKUP_DONE":
        card.complete();
        activePort = null;
        activeRequestId = "";
        port.disconnect();
        break;
      case "LOOKUP_ERROR":
        card.showError(message.message);
        activePort = null;
        activeRequestId = "";
        port.disconnect();
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
    payload
  });
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
    card.setAppearance(settings.ui);
  }
});

void loadState();
