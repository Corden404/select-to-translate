import { getSelectionAnchor } from "./anchor";
import { extractContext } from "./context-extractor";
import { FloatingCard } from "./floating-card";
import { classifySelection } from "../shared/selection";

const STORAGE_KEY = "autoLookupEnabled";
const card = new FloatingCard();

let enabled = true;
let scheduled: number | null = null;
let lastFingerprint = "";

async function loadEnabledState(): Promise<void> {
  const stored = await chrome.storage.local.get({ [STORAGE_KEY]: true });
  enabled = stored[STORAGE_KEY] !== false;
  if (!enabled) card.hide();
}

function fingerprint(text: string, anchorTop: number, anchorLeft: number): string {
  return `${text}\u0000${Math.round(anchorTop)}\u0000${Math.round(anchorLeft)}`;
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

  card.cancelStream();
  const context = extractContext(selection, classified.kind, classified.text);
  card.show({ selection: classified, context }, anchor);
}

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
  if (areaName !== "local" || !changes[STORAGE_KEY]) return;

  enabled = changes[STORAGE_KEY].newValue !== false;
  lastFingerprint = "";
  if (!enabled) card.hide();
});

void loadEnabledState();
