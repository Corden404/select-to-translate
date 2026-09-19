import { putHistoryRecord } from "../history/db";
import type { LookupHistoryRecord } from "../history/types";
import { streamOpenAiCompatible } from "../llm/openai-compatible";
import { getYoudaoPronunciation } from "../pronunciation/youdao";
import type {
  LookupPortRequest,
  LookupPortResponse,
  OneShotMessage,
  PronunciationResponse
} from "../shared/messages";
import { buildLookupMessages, type ChatMessage } from "../shared/prompts";
import { countEnglishWords } from "../shared/selection";
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
  if (command === "toggle-auto-lookup") void toggleEnabled();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[AUTO_LOOKUP_STORAGE_KEY]) return;
  void updateBadge(changes[AUTO_LOOKUP_STORAGE_KEY].newValue !== false);
});

function isSafeSourceUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return ["http:", "https:", "chrome-extension:", "local-pdf:", "about:"].includes(protocol);
  } catch {
    return false;
  }
}

function validOptionalContext(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.length <= 12000);
}

function isLookupRequest(message: unknown): message is LookupPortRequest {
  if (!message || typeof message !== "object") return false;
  const candidate = message as Partial<LookupPortRequest>;
  if (candidate.type === "CHAT_SEND") {
    return typeof candidate.requestId === "string"
      && candidate.requestId.length <= 100
      && typeof candidate.message === "string"
      && candidate.message.trim().length > 0
      && candidate.message.length <= 4000;
  }
  if (candidate.type !== "LOOKUP_START") return false;
  return typeof candidate.requestId === "string"
    && candidate.requestId.length <= 100
    && (!candidate.promptId || (typeof candidate.promptId === "string" && candidate.promptId.length <= 80))
    && !!candidate.payload
    && typeof candidate.payload.selectedText === "string"
    && candidate.payload.selectedText.length <= 4000
    && countEnglishWords(candidate.payload.selectedText) >= 1
    && countEnglishWords(candidate.payload.selectedText) <= 30
    && (candidate.payload.kind === "word" || candidate.payload.kind === "sentence")
    && typeof candidate.payload.context?.currentSentence === "string"
    && candidate.payload.context.currentSentence.length <= 12000
    && validOptionalContext(candidate.payload.context.previousSentence)
    && validOptionalContext(candidate.payload.context.nextSentence)
    && (!candidate.payload.sourceType || candidate.payload.sourceType === "web" || candidate.payload.sourceType === "pdf")
    && typeof candidate.payload.pageUrl === "string"
    && candidate.payload.pageUrl.length <= 5000
    && isSafeSourceUrl(candidate.payload.pageUrl)
    && typeof candidate.payload.pageTitle === "string"
    && candidate.payload.pageTitle.length <= 1000;
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== "lookup-stream") return;

  let controller: AbortController | null = null;
  let disconnected = false;
  let activeRecord: LookupHistoryRecord | null = null;
  let conversation: ChatMessage[] = [];
  let activeRequestId = "";
  let streamInProgress = false;
  let pendingAssistant = "";
  let streamMode: "lookup" | "chat" | null = null;

  const safePost = (message: LookupPortResponse) => {
    if (disconnected) return;
    try {
      port.postMessage(message);
    } catch {
      // Navigation or explicit cancellation can close the port between chunks.
    }
  };

  const saveRecord = async () => {
    if (!activeRecord) return;
    activeRecord.updatedAt = Date.now();
    await putHistoryRecord(activeRecord);
  };

  const abortStreaming = () => {
    controller?.abort();
    controller = null;
  };

  port.onDisconnect.addListener(() => {
    disconnected = true;
    if (activeRecord && streamInProgress) {
      if (pendingAssistant) {
        conversation.push({ role: "assistant", content: pendingAssistant });
        activeRecord.messages = [...conversation];
        if (streamMode === "lookup" && !activeRecord.initialResponse) {
          activeRecord.initialResponse = pendingAssistant;
        }
      }
      activeRecord.status = "aborted";
      streamInProgress = false;
      pendingAssistant = "";
      streamMode = null;
      void saveRecord();
    }
    abortStreaming();
  });

  async function streamAssistant(
    requestId: string,
    mode: "lookup" | "chat",
    settings: Awaited<ReturnType<typeof loadLookupSettings>>
  ): Promise<void> {
    abortStreaming();
    controller = new AbortController();
    streamInProgress = true;
    streamMode = mode;
    pendingAssistant = "";
    let assistant = "";

    safePost(mode === "lookup"
      ? { type: "LOOKUP_STARTED", requestId, recordId: activeRecord!.id, promptId: activeRecord!.prompt.id, promptName: activeRecord!.prompt.name }
      : { type: "CHAT_STARTED", requestId });

    try {
      await streamOpenAiCompatible(
        {
          baseUrl: settings.api.baseUrl,
          apiKey: settings.api.apiKey,
          model: settings.api.model,
          timeoutMs: settings.api.timeoutMs,
          messages: conversation
        },
        controller.signal,
        text => {
          assistant += text;
          pendingAssistant = assistant;
          safePost(mode === "lookup"
            ? { type: "LOOKUP_CHUNK", requestId, text }
            : { type: "CHAT_CHUNK", requestId, text });
        }
      );

      conversation.push({ role: "assistant", content: assistant });
      activeRecord!.messages = [...conversation];
      if (mode === "lookup") activeRecord!.initialResponse = assistant;
      activeRecord!.status = "completed";
      activeRecord!.errorMessage = undefined;
      streamInProgress = false;
      pendingAssistant = "";
      streamMode = null;
      await saveRecord();

      safePost(mode === "lookup"
        ? { type: "LOOKUP_DONE", requestId }
        : { type: "CHAT_DONE", requestId });
    } catch (error) {
      if (controller.signal.aborted) return;
      streamInProgress = false;
      pendingAssistant = "";
      streamMode = null;
      activeRecord!.status = "error";
      activeRecord!.errorMessage = error instanceof Error ? error.message : "未知错误";
      if (assistant) {
        conversation.push({ role: "assistant", content: assistant });
        activeRecord!.messages = [...conversation];
      }
      await saveRecord();
      safePost({
        type: "LOOKUP_ERROR",
        requestId,
        message: activeRecord!.errorMessage
      });
    }
  }

  port.onMessage.addListener((message: unknown) => {
    if (!isLookupRequest(message)) return;

    void (async () => {
      if (message.type === "LOOKUP_START") {
        abortStreaming();
        const settings = await loadLookupSettings();
        const built = buildLookupMessages(settings, message.payload, message.promptId);
        activeRequestId = message.requestId;
        conversation = [...built.messages];

        activeRecord = {
          id: crypto.randomUUID(),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          selectedText: message.payload.selectedText,
          queryType: message.payload.kind,
          sourceType: message.payload.sourceType === "pdf" ? "pdf" : "web",
          pageUrl: message.payload.pageUrl,
          pageTitle: message.payload.pageTitle,
          context: { ...message.payload.context },
          prompt: {
            id: built.prompt.id,
            version: built.prompt.version,
            name: built.prompt.name,
            snapshot: built.prompt.systemPrompt + "\n\n[USER TEMPLATE]\n" + built.prompt.userTemplate
          },
          provider: settings.api.provider,
          model: settings.api.model,
          initialResponse: "",
          messages: [...conversation],
          status: "streaming"
        };
        await saveRecord();
        await streamAssistant(message.requestId, "lookup", settings);
        return;
      }

      if (!activeRecord || message.requestId !== activeRequestId) {
        safePost({
          type: "LOOKUP_ERROR",
          requestId: message.requestId,
          message: "当前会话已经结束，请重新选择文本。"
        });
        return;
      }

      const userMessage = message.message.trim();
      conversation.push({ role: "user", content: userMessage });
      activeRecord.messages = [...conversation];
      activeRecord.status = "streaming";
      await saveRecord();

      const settings = await loadLookupSettings();
      await streamAssistant(message.requestId, "chat", settings);
    })().catch(error => {
      safePost({
        type: "LOOKUP_ERROR",
        requestId: (message as LookupPortRequest).requestId,
        message: error instanceof Error ? error.message : "处理请求失败"
      });
    });
  });
});

chrome.runtime.onMessage.addListener((
  message: OneShotMessage,
  _sender,
  sendResponse: (response: PronunciationResponse) => void
) => {
  if (!message || message.type !== "PRONUNCIATION_GET" || typeof message.word !== "string") {
    return false;
  }

  void (async () => {
    try {
      const settings = await loadLookupSettings();
      const result = await getYoudaoPronunciation(
        message.word,
        settings.pronunciation.youdao
      );
      sendResponse({ ok: true, ...result });
    } catch (error) {
      sendResponse({
        ok: false,
        message: error instanceof Error ? error.message : "发音查询失败"
      });
    }
  })();

  return true;
});
