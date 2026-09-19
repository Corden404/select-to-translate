import { streamOpenAiCompatible } from "../llm/openai-compatible";
import type { LookupPortRequest, LookupPortResponse } from "../shared/messages";
import { buildLookupMessages } from "../shared/prompts";
import {
  AUTO_LOOKUP_STORAGE_KEY,
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  loadLookupSettings
} from "../shared/settings";

async function getEnabled(): Promise<boolean> {
  const stored = await chrome.storage.local.get({ [AUTO_LOOKUP_STORAGE_KEY]: true });
  return stored[AUTO_LOOKUP_STORAGE_KEY] !== false;
}

async function updateBadge(enabled: boolean): Promise<void> {
  await chrome.action.setBadgeText({ text: enabled ? "开" : "关" });
  await chrome.action.setTitle({
    title: enabled ? "右键查词工具：自动查词已开启" : "右键查词工具：自动查词已关闭"
  });
}

async function setEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [AUTO_LOOKUP_STORAGE_KEY]: enabled });
  await updateBadge(enabled);
}

async function toggleEnabled(): Promise<void> {
  await setEnabled(!(await getEnabled()));
}

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    const stored = await chrome.storage.local.get([
      AUTO_LOOKUP_STORAGE_KEY,
      SETTINGS_STORAGE_KEY
    ]);

    const updates: Record<string, unknown> = {};
    if (typeof stored[AUTO_LOOKUP_STORAGE_KEY] !== "boolean") {
      updates[AUTO_LOOKUP_STORAGE_KEY] = true;
    }
    if (!stored[SETTINGS_STORAGE_KEY]) {
      updates[SETTINGS_STORAGE_KEY] = DEFAULT_SETTINGS;
    }
    if (Object.keys(updates).length > 0) {
      await chrome.storage.local.set(updates);
    }

    await updateBadge(await getEnabled());
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void getEnabled().then(updateBadge);
});

chrome.commands.onCommand.addListener(command => {
  if (command === "toggle-auto-lookup") {
    void toggleEnabled();
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[AUTO_LOOKUP_STORAGE_KEY]) return;
  void updateBadge(changes[AUTO_LOOKUP_STORAGE_KEY].newValue !== false);
});

function isLookupRequest(message: unknown): message is LookupPortRequest {
  if (!message || typeof message !== "object") return false;
  const candidate = message as Partial<LookupPortRequest>;
  return candidate.type === "LOOKUP_START"
    && typeof candidate.requestId === "string"
    && !!candidate.payload
    && typeof candidate.payload.selectedText === "string"
    && (candidate.payload.kind === "word" || candidate.payload.kind === "sentence")
    && typeof candidate.payload.context?.currentSentence === "string";
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== "lookup-stream") return;

  let controller: AbortController | null = null;
  let disconnected = false;

  const safePost = (message: LookupPortResponse) => {
    if (disconnected) return;
    try {
      port.postMessage(message);
    } catch {
      // The page may have navigated or the content script may have cancelled.
    }
  };

  port.onDisconnect.addListener(() => {
    disconnected = true;
    controller?.abort();
  });

  port.onMessage.addListener((message: unknown) => {
    if (!isLookupRequest(message)) return;

    controller?.abort();
    controller = new AbortController();
    const { requestId, payload } = message;

    void (async () => {
      try {
        const settings = await loadLookupSettings();
        safePost({ type: "LOOKUP_STARTED", requestId });

        await streamOpenAiCompatible(
          {
            baseUrl: settings.api.baseUrl,
            apiKey: settings.api.apiKey,
            model: settings.api.model,
            messages: buildLookupMessages(settings, payload)
          },
          controller!.signal,
          text => safePost({ type: "LOOKUP_CHUNK", requestId, text })
        );

        safePost({ type: "LOOKUP_DONE", requestId });
      } catch (error) {
        if (controller?.signal.aborted) return;
        const message = error instanceof Error ? error.message : "未知错误";
        safePost({ type: "LOOKUP_ERROR", requestId, message });
      }
    })();
  });
});
