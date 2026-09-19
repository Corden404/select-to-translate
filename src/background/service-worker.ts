import { putHistoryRecord } from "../history/db";
import type { LookupHistoryRecord } from "../history/types";
import { streamOpenAiCompatible, testOpenAiCompatibleConnection } from "../llm/openai-compatible";
import { getMiMoPronunciation } from "../pronunciation/mimo";
import { getYoudaoPronunciation } from "../pronunciation/youdao";
import type {
  ConnectionTestResponse,
  LookupPortRequest,
  LookupPortResponse,
  OneShotMessage,
  PronunciationResponse,
  PublicSettingsResponse
} from "../shared/messages";
import {
  isLookupPortRequest,
  recoverLookupRequestId
} from "../shared/messages";
import { buildLookupMessages, type ChatMessage } from "../shared/prompts";
import {
  AUTO_LOOKUP_STORAGE_KEY,
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  loadLookupSettings,
  toPublicLookupSettings
} from "../shared/settings";

async function restrictLocalStorageAccess(): Promise<void> {
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
}

void restrictLocalStorageAccess();

async function getEnabled(): Promise<boolean> {
  const stored = await chrome.storage.local.get({ [AUTO_LOOKUP_STORAGE_KEY]: true });
  return stored[AUTO_LOOKUP_STORAGE_KEY] !== false;
}

async function getPublicState(): Promise<PublicSettingsResponse> {
  const [enabled, settings] = await Promise.all([
    getEnabled(),
    loadLookupSettings()
  ]);
  return {
    ok: true,
    enabled,
    settings: toPublicLookupSettings(settings)
  };
}

async function broadcastPublicState(): Promise<void> {
  const state = await getPublicState();
  if (!state.settings) return;
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs.map(async tab => {
    if (typeof tab.id !== "number") return;
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: "PUBLIC_SETTINGS_CHANGED",
        enabled: state.enabled,
        settings: state.settings
      });
    } catch {
      // Tabs without this extension's content script are expected.
    }
  }));
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
    await restrictLocalStorageAccess();
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
  void (async () => {
    await restrictLocalStorageAccess();
    await updateBadge(await getEnabled());
  })();
});

chrome.commands.onCommand.addListener(command => {
  if (command === "toggle-auto-lookup") void toggleEnabled();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes[AUTO_LOOKUP_STORAGE_KEY]) {
    void updateBadge(changes[AUTO_LOOKUP_STORAGE_KEY].newValue !== false);
  }
  if (changes[AUTO_LOOKUP_STORAGE_KEY] || changes[SETTINGS_STORAGE_KEY]) {
    void broadcastPublicState();
  }
});

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== "lookup-stream") return;

  let controller: AbortController | null = null;
  let disconnected = false;
  let activeRecord: LookupHistoryRecord | null = null;
  let conversation: ChatMessage[] = [];
  let activeRequestId = "";
  let streamInProgress = false;
  let chatDispatchInProgress = false;
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

  const saveRecord = async (record: LookupHistoryRecord | null = activeRecord) => {
    if (!record) return;
    record.updatedAt = Date.now();
    await putHistoryRecord(record);
  };

  const abortStreaming = () => {
    const current = controller;
    current?.abort();
    if (controller === current) controller = null;
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
    const streamController = new AbortController();
    const record = activeRecord;
    const streamConversation = conversation;
    if (!record) throw new Error("当前会话已经结束，请重新选择文本。");
    controller = streamController;
    streamInProgress = true;
    streamMode = mode;
    pendingAssistant = "";
    let assistant = "";
    const ownsStream = () => controller === streamController;

    safePost(mode === "lookup"
      ? { type: "LOOKUP_STARTED", requestId, recordId: record.id, promptId: record.prompt.id, promptName: record.prompt.name }
      : { type: "CHAT_STARTED", requestId });

    try {
      await streamOpenAiCompatible(
        {
          baseUrl: settings.api.baseUrl,
          apiKey: settings.api.apiKey,
          model: settings.api.model,
          timeoutMs: settings.api.timeoutMs,
          messages: streamConversation
        },
        streamController.signal,
        text => {
          if (!ownsStream() || streamController.signal.aborted) return;
          assistant += text;
          pendingAssistant = assistant;
          safePost(mode === "lookup"
            ? { type: "LOOKUP_CHUNK", requestId, text }
            : { type: "CHAT_CHUNK", requestId, text });
        }
      );

      if (!ownsStream() || streamController.signal.aborted) return;
      streamConversation.push({ role: "assistant", content: assistant });
      record.messages = [...streamConversation];
      if (mode === "lookup") record.initialResponse = assistant;
      record.status = "completed";
      record.errorMessage = undefined;
      controller = null;
      streamInProgress = false;
      pendingAssistant = "";
      streamMode = null;
      await saveRecord(record);

      safePost(mode === "lookup"
        ? { type: "LOOKUP_DONE", requestId }
        : { type: "CHAT_DONE", requestId });
    } catch (error) {
      if (streamController.signal.aborted || !ownsStream()) return;
      controller = null;
      streamInProgress = false;
      pendingAssistant = "";
      streamMode = null;
      record.status = "error";
      record.errorMessage = error instanceof Error ? error.message : "未知错误";
      if (assistant) {
        streamConversation.push({ role: "assistant", content: assistant });
        record.messages = [...streamConversation];
      }
      await saveRecord(record);
      safePost(mode === "lookup" ? {
        type: "LOOKUP_ERROR",
        requestId,
        message: record.errorMessage
      } : {
        type: "CHAT_ERROR",
        requestId,
        message: record.errorMessage
      });
    }
  }

  port.onMessage.addListener((message: unknown) => {
    const rawType = message && typeof message === "object"
      ? (message as { type?: unknown }).type
      : undefined;
    const recoverableRequestId = recoverLookupRequestId(message);
    if (!isLookupPortRequest(message)) {
      if (recoverableRequestId && rawType === "LOOKUP_START") {
        safePost({
          type: "LOOKUP_ERROR",
          requestId: recoverableRequestId,
          message: "查词请求数据无效或超过长度限制。"
        });
      } else if (recoverableRequestId && rawType === "CHAT_SEND") {
        safePost({
          type: "CHAT_ERROR",
          requestId: recoverableRequestId,
          message: "追问内容无效或超过长度限制。"
        });
      }
      return;
    }

    if (message.type === "CHAT_SEND") {
      if (streamInProgress || chatDispatchInProgress) {
        safePost({
          type: "CHAT_ERROR",
          requestId: message.requestId,
          message: "上一条回复仍在生成，请稍后再发送。"
        });
        return;
      }
      chatDispatchInProgress = true;
    }

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
          type: "CHAT_ERROR",
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
        type: message.type === "CHAT_SEND" ? "CHAT_ERROR" : "LOOKUP_ERROR",
        requestId: (message as LookupPortRequest).requestId,
        message: error instanceof Error ? error.message : "处理请求失败"
      });
    }).finally(() => {
      if (message.type === "CHAT_SEND") chatDispatchInProgress = false;
    });
  });
});

chrome.runtime.onMessage.addListener((
  message: OneShotMessage,
  sender,
  sendResponse: (response: PronunciationResponse | ConnectionTestResponse | PublicSettingsResponse) => void
) => {
  if (!message || typeof message !== "object" || typeof message.type !== "string") {
    return false;
  }

  const isConnectionTest = message.type === "TEST_LLM_CONNECTION"
    || message.type === "TEST_PRONUNCIATION_CONNECTION";
  const extensionSource = typeof sender.url === "string"
    ? sender.url
    : typeof sender.origin === "string"
      ? sender.origin
      : "";
  const isTrustedExtensionPage = extensionSource.startsWith("chrome-extension://");

  if (isConnectionTest && !isTrustedExtensionPage) {
    return false;
  }

  void (async () => {
    if (message.type === "PUBLIC_SETTINGS_GET") {
      try {
        sendResponse(await getPublicState());
      } catch (error) {
        sendResponse({
          ok: false,
          enabled: false,
          message: error instanceof Error ? error.message : "无法读取公开设置。"
        });
      }
      return;
    }

    if (message.type === "TEST_LLM_CONNECTION") {
      const startedAt = performance.now();
      try {
        const config = message.config;
        if (!config
          || typeof config.baseUrl !== "string"
          || typeof config.apiKey !== "string"
          || typeof config.model !== "string"
          || !Number.isFinite(config.timeoutMs)
        ) {
          throw new Error("测试配置不完整。");
        }

        const result = await testOpenAiCompatibleConnection({
          baseUrl: config.baseUrl.slice(0, 5000),
          apiKey: config.apiKey.slice(0, 1000),
          model: config.model.slice(0, 300),
          timeoutMs: Math.min(120000, Math.max(5000, config.timeoutMs))
        });

        sendResponse({
          ok: true,
          provider: "llm",
          latencyMs: result.latencyMs,
          preview: result.preview,
          message: "模型 API 连接成功。"
        });
      } catch (error) {
        sendResponse({
          ok: false,
          provider: "llm",
          latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
          message: error instanceof Error ? error.message : "模型 API 测试失败。"
        });
      }
      return;
    }

    if (message.type === "TEST_PRONUNCIATION_CONNECTION") {
      const startedAt = performance.now();
      try {
        if (message.provider === "mimo") {
          if (!message.mimo) throw new Error("MiMo TTS 测试配置不完整。");
          const result = await getMiMoPronunciation("hello", message.mimo);
          sendResponse({
            ok: true,
            provider: "mimo",
            latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
            preview: result.label ?? "已收到 WAV 音频",
            message: "MiMo TTS 连接成功，已生成测试音频。"
          });
          return;
        }

        if (message.provider === "youdao") {
          if (!message.youdao) throw new Error("有道测试配置不完整。");
          const result = await getYoudaoPronunciation("hello", {
            enabled: true,
            appKey: message.youdao.appKey,
            appSecret: message.youdao.appSecret
          });
          sendResponse({
            ok: true,
            provider: "youdao",
            latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
            preview: result.phonetic ? "UK /" + result.phonetic + "/" : result.label,
            message: "有道词典连接成功。"
          });
          return;
        }

        throw new Error("不支持的发音 Provider。");
      } catch (error) {
        sendResponse({
          ok: false,
          provider: message.provider,
          latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
          message: error instanceof Error ? error.message : "发音 API 测试失败。"
        });
      }
      return;
    }

    if (message.type !== "PRONUNCIATION_GET" || typeof message.word !== "string") {
      return;
    }

    try {
      const settings = await loadLookupSettings();
      if (settings.pronunciation.provider === "off") {
        throw new Error("发音功能已关闭。");
      }

      if (settings.pronunciation.provider === "mimo") {
        const mimoApiKey = settings.pronunciation.mimo.apiKey
          || (settings.api.provider === "mimo" ? settings.api.apiKey : "");
        const result = await getMiMoPronunciation(message.word, {
          ...settings.pronunciation.mimo,
          apiKey: mimoApiKey
        });
        sendResponse({ ok: true, provider: "mimo", ...result });
        return;
      }

      const result = await getYoudaoPronunciation(
        message.word,
        { ...settings.pronunciation.youdao, enabled: true }
      );
      sendResponse({ ok: true, provider: "youdao", ...result });
    } catch (error) {
      sendResponse({
        ok: false,
        message: error instanceof Error ? error.message : "发音查询失败"
      });
    }
  })();

  return true;
});
