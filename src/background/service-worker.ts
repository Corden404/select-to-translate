import { pruneHistory, putHistoryRecord } from "../history/db";
import type { LookupHistoryRecord } from "../history/types";
import { streamOpenAiCompatible, testOpenAiCompatibleConnection } from "../llm/openai-compatible";
import { getMiMoPronunciation, streamMiMoExplanationSpeech } from "../pronunciation/mimo";
import { getYoudaoPronunciation } from "../pronunciation/youdao";
import type {
  ConnectionTestResponse,
  LookupPortRequest,
  LookupPortResponse,
  LookupRequestPayload,
  OneShotMessage,
  PronunciationResponse,
  PublicSettingsResponse,
  SpeechActionResponse,
  SpeechLatencyReport
} from "../shared/messages";
import {
  isLookupPortRequest,
  recoverLookupRequestId
} from "../shared/messages";
import {
  buildLookupMessages,
  buildSpeechExplanationMessages,
  type ChatMessage
} from "../shared/prompts";
import {
  AUTO_LOOKUP_STORAGE_KEY,
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  loadLookupSettings,
  resolveSpeechExplanationApi,
  toPublicLookupSettings
} from "../shared/settings";
import { OPTIONS_SOURCE_STORAGE_KEY } from "../shared/options-source";

interface SpeechSession {
  requestId: string;
  scriptController: AbortController;
  ttsController: AbortController | null;
}

interface ReplayableSpeech {
  requestId: string;
  playbackRate: number;
}

let activeSpeechSession: SpeechSession | null = null;
let offscreenCreation: Promise<void> | null = null;
let latestSpeechLookupRequestId = "";
let replayableSpeech: ReplayableSpeech | null = null;
const cancelledSpeechRequestIds = new Set<string>();
const lookupStartsBySource = new Map<string, number[]>();
const MANUAL_LOOKUP_MENU_ID = "manual-lookup-selection";

function allowLookupBurst(sourceKey: string): boolean {
  const now = Date.now();
  const recent = (lookupStartsBySource.get(sourceKey) ?? [])
    .filter(timestamp => now - timestamp < 10000);
  if (recent.length >= 20) {
    lookupStartsBySource.set(sourceKey, recent);
    return false;
  }
  recent.push(now);
  lookupStartsBySource.set(sourceKey, recent);
  return true;
}

async function ensureOffscreenDocument(): Promise<void> {
  if (offscreenCreation) {
    await offscreenCreation;
    return;
  }
  if (await chrome.offscreen.hasDocument()) return;

  offscreenCreation = chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
    justification: "Play automatic vocabulary explanation audio."
  }).finally(() => {
    offscreenCreation = null;
  });
  await offscreenCreation;
}

async function stopOffscreenAudio(requestId?: string): Promise<void> {
  if (!(await chrome.offscreen.hasDocument())) return;
  try {
    await chrome.runtime.sendMessage({
      target: "offscreen-audio",
      type: "STOP_AUDIO",
      requestId
    });
  } catch {
    // The offscreen document may close between the presence check and the message.
  }
}

async function cancelSpeechSession(requestId?: string): Promise<void> {
  const current = activeSpeechSession;
  if (requestId && current && current.requestId !== requestId) return;

  if (current) {
    activeSpeechSession = null;
    current.scriptController.abort();
    current.ttsController?.abort();
  }
  if (!requestId || replayableSpeech?.requestId === requestId) replayableSpeech = null;
  await stopOffscreenAudio(requestId);
}

function cleanSpeechScript(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^[\s>*#-]+/gm, "")
    .replace(/[*_`]/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim()
    .slice(0, 1200);
}

async function startSpeechExplanation(
  requestId: string,
  payload: LookupRequestPayload,
  settings: Awaited<ReturnType<typeof loadLookupSettings>>,
  triggeredAt: number,
  workerReceivedAt: number,
  workerReceivedPerf: number,
  onReady?: () => void,
  onTiming?: (report: SpeechLatencyReport) => void
): Promise<void> {
  const previous = activeSpeechSession;
  if (requestId !== latestSpeechLookupRequestId || cancelledSpeechRequestIds.has(requestId)) return;
  previous?.scriptController.abort();
  previous?.ttsController?.abort();

  const session: SpeechSession = {
    requestId,
    scriptController: new AbortController(),
    ttsController: null
  };
  activeSpeechSession = session;

  await stopOffscreenAudio();
  if (activeSpeechSession !== session || session.scriptController.signal.aborted) return;

  const llmStartedAt = performance.now();
  let llmFirstTokenAt: number | null = null;
  let script = "";
  try {
    const speechApi = resolveSpeechExplanationApi(settings);
    await streamOpenAiCompatible(
      {
        baseUrl: speechApi.baseUrl,
        apiKey: speechApi.apiKey,
        model: speechApi.model,
        timeoutMs: speechApi.timeoutMs,
        messages: buildSpeechExplanationMessages(settings, payload)
      },
      session.scriptController.signal,
      text => {
        if (activeSpeechSession === session && !session.scriptController.signal.aborted) {
          script += text;
          if (llmFirstTokenAt === null) llmFirstTokenAt = performance.now();
        }
      }
    );

    if (activeSpeechSession !== session || session.scriptController.signal.aborted) return;
    const llmCompletedAt = performance.now();
    const speechText = cleanSpeechScript(script);
    if (!speechText) throw new Error("语音讲解模型没有返回可朗读的内容。");

    const ttsController = new AbortController();
    session.ttsController = ttsController;
    const mimoApiKey = settings.pronunciation.mimo.apiKey
      || (settings.api.provider === "mimo" ? settings.api.apiKey : "");

    const offscreenStartedAt = performance.now();
    let offscreenReadyAt = offscreenStartedAt;
    const streamStartPromise = (async () => {
      await ensureOffscreenDocument();
      const response = await chrome.runtime.sendMessage({
        target: "offscreen-audio",
        type: "STREAM_START",
        requestId,
        playbackRate: settings.speechExplanation.playbackRate
      }) as SpeechActionResponse | undefined;
      if (!response?.ok) throw new Error(response?.message ?? "无法启动流式音频播放器。");
      offscreenReadyAt = performance.now();
    })();

    let firstChunkReceivedAt: number | null = null;
    let firstPlaybackAt: number | null = null;
    let firstPlaybackEpoch: number | null = null;
    let chunkSendChain = Promise.resolve();
    let chunkSendError: unknown = null;

    const result = await streamMiMoExplanationSpeech(
      speechText,
      {
        ...settings.pronunciation.mimo,
        apiKey: mimoApiKey,
        style: settings.speechExplanation.ttsStyle
      },
      audioBase64 => {
        const receivedAt = performance.now();
        if (firstChunkReceivedAt === null) firstChunkReceivedAt = receivedAt;
        chunkSendChain = chunkSendChain.then(async () => {
          if (chunkSendError) return;
          await streamStartPromise;
          if (activeSpeechSession !== session || ttsController.signal.aborted) return;
          const response = await chrome.runtime.sendMessage({
            target: "offscreen-audio",
            type: "STREAM_CHUNK",
            requestId,
            audioBase64
          }) as (SpeechActionResponse & { started?: boolean }) | undefined;
          if (!response?.ok) throw new Error(response?.message ?? "流式音频播放失败。");
          if (response.started && firstPlaybackAt === null) {
            firstPlaybackAt = performance.now();
            firstPlaybackEpoch = Date.now();
          }
        }).catch(error => {
          if (!chunkSendError) chunkSendError = error;
        });
      },
      ttsController.signal
    );

    await chunkSendChain;
    if (chunkSendError) throw chunkSendError;
    await streamStartPromise;
    if (activeSpeechSession !== session || ttsController.signal.aborted) return;
    const endResponse = await chrome.runtime.sendMessage({
      target: "offscreen-audio",
      type: "STREAM_END",
      requestId
    }) as SpeechActionResponse | undefined;
    if (!endResponse?.ok) throw new Error(endResponse?.message ?? "流式音频结束失败。");

    if (endResponse.replayable) {
      replayableSpeech = {
        requestId,
        playbackRate: settings.speechExplanation.playbackRate
      };
      onReady?.();
    } else if (replayableSpeech?.requestId === requestId) {
      replayableSpeech = null;
    }

    const firstTokenAt = llmFirstTokenAt ?? llmCompletedAt;
    const firstChunkAt = firstChunkReceivedAt ?? performance.now();
    const playbackAt = firstPlaybackAt ?? firstChunkAt;
    onTiming?.({
      triggerToWorkerMs: Math.max(0, workerReceivedAt - triggeredAt),
      workerPrepMs: Math.max(0, llmStartedAt - workerReceivedPerf),
      llmTtftMs: Math.max(0, firstTokenAt - llmStartedAt),
      llmGenerationMs: Math.max(0, llmCompletedAt - firstTokenAt),
      llmTotalMs: Math.max(0, llmCompletedAt - llmStartedAt),
      ttsMs: result.totalMs,
      ttsHeadersMs: result.headersMs,
      ttsFirstAudioAfterHeadersMs: result.firstAudioAfterHeadersMs,
      ttsFirstChunkMs: result.headersMs + result.firstAudioAfterHeadersMs,
      ttsRemainingStreamMs: result.remainingStreamMs,
      ttsParseMs: result.parseMs,
      ttsChunkCount: result.chunkCount,
      speechChars: result.inputChars,
      ttsResponseBytes: result.responseBytes,
      audioBytes: result.audioBytes,
      offscreenReadyMs: Math.max(0, offscreenReadyAt - offscreenStartedAt),
      audioStartMs: Math.max(0, playbackAt - firstChunkAt),
      totalMs: Math.max(0, (firstPlaybackEpoch ?? Date.now()) - triggeredAt)
    });
  } catch (error) {
    if (activeSpeechSession !== session
      || session.scriptController.signal.aborted
      || session.ttsController?.signal.aborted) {
      return;
    }
    if (replayableSpeech?.requestId === requestId) replayableSpeech = null;
    await stopOffscreenAudio(requestId);
    activeSpeechSession = null;
    console.warn("自动语音解释失败：", error);
  }
}

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
    title: enabled ? "打开右键查词工具设置 · 查词已开启" : "打开右键查词工具设置 · 查词已关闭"
  });
}

async function sendManualLookup(tabId: number, frameId?: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(
      tabId,
      { type: "MANUAL_LOOKUP_TRIGGER" },
      typeof frameId === "number" ? { frameId } : undefined
    );
  } catch {
    // Pages without a compatible content script are expected.
  }
}

function installContextMenu(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MANUAL_LOOKUP_MENU_ID,
      title: "使用右键查词工具查询选中文字",
      contexts: ["selection"]
    });
  });
}

async function setEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [AUTO_LOOKUP_STORAGE_KEY]: enabled });
  await updateBadge(enabled);
}

async function toggleEnabled(): Promise<void> {
  await setEnabled(!(await getEnabled()));
}

async function openOptionsFromTab(tab: chrome.tabs.Tab): Promise<void> {
  try {
    if (typeof tab.id === "number") {
      await chrome.storage.session.set({
        [OPTIONS_SOURCE_STORAGE_KEY]: {
          tabId: tab.id,
          windowId: tab.windowId,
          url: tab.url ?? "",
          title: tab.title ?? "",
          capturedAt: Date.now()
        }
      });
    } else {
      await chrome.storage.session.remove(OPTIONS_SOURCE_STORAGE_KEY);
    }
  } catch (error) {
    console.warn("无法记录设置页来源标签：", error);
  }
  await chrome.runtime.openOptionsPage();
}

chrome.action.onClicked.addListener(tab => {
  void openOptionsFromTab(tab);
});

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
    installContextMenu();
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    await restrictLocalStorageAccess();
    await updateBadge(await getEnabled());
    installContextMenu();
  })();
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "toggle-auto-lookup") {
    void toggleEnabled();
    return;
  }
  if (command === "lookup-selection" && typeof tab?.id === "number") {
    void sendManualLookup(tab.id);
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MANUAL_LOOKUP_MENU_ID || typeof tab?.id !== "number") return;
  void sendManualLookup(tab.id, info.frameId);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes[AUTO_LOOKUP_STORAGE_KEY]) {
    void updateBadge(changes[AUTO_LOOKUP_STORAGE_KEY].newValue !== false);
  }
  if (changes[AUTO_LOOKUP_STORAGE_KEY] || changes[SETTINGS_STORAGE_KEY]) {
    void broadcastPublicState();
  }
  if (changes[AUTO_LOOKUP_STORAGE_KEY]?.newValue === false) {
    void cancelSpeechSession();
  } else if (changes[SETTINGS_STORAGE_KEY]) {
    void loadLookupSettings().then(async settings => {
      if (settings.history.enabled) await pruneHistory(settings.history);
      if (!settings.speechExplanation.enabled) await cancelSpeechSession();
    }).catch(() => undefined);
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
  let historySettings = { ...DEFAULT_SETTINGS.history };
  const lookupSourceKey = `${port.sender?.tab?.id ?? "extension"}:${port.sender?.frameId ?? 0}`;

  const safePost = (message: LookupPortResponse) => {
    if (disconnected) return;
    try {
      port.postMessage(message);
    } catch {
      // Navigation or explicit cancellation can close the port between chunks.
    }
  };

  const saveRecord = async (record: LookupHistoryRecord | null = activeRecord) => {
    if (!record || !historySettings.enabled) return;
    record.updatedAt = Date.now();
    await putHistoryRecord(record, historySettings);
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
      if (mode === "lookup" && assistant) record.initialResponse = assistant;
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
    const workerReceivedAt = Date.now();
    const workerReceivedPerf = performance.now();
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

    if (message.type === "LOOKUP_START" && !allowLookupBurst(lookupSourceKey)) {
      safePost({
        type: "LOOKUP_ERROR",
        requestId: message.requestId,
        message: "查词请求过于频繁，请稍后再试。"
      });
      return;
    }

    const speechStop = message.type === "LOOKUP_START"
      ? (() => {
          latestSpeechLookupRequestId = message.requestId;
          return cancelSpeechSession();
        })()
      : Promise.resolve();

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
        const [settings] = await Promise.all([
          loadLookupSettings(),
          speechStop
        ]);
        historySettings = { ...settings.history };
        if (message.requestId === latestSpeechLookupRequestId
          && !cancelledSpeechRequestIds.has(message.requestId)
          && settings.speechExplanation.enabled
          && message.payload.kind === "word") {
          void startSpeechExplanation(
            message.requestId,
            message.payload,
            settings,
            message.triggeredAt,
            workerReceivedAt,
            workerReceivedPerf,
            () => safePost({ type: "SPEECH_READY", requestId: message.requestId }),
            report => safePost({ type: "SPEECH_TIMING", requestId: message.requestId, report })
          );
        }
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

      const settings = await loadLookupSettings();
      historySettings = { ...settings.history };
      const userMessage = message.message.trim();
      conversation.push({ role: "user", content: userMessage });
      activeRecord.messages = [...conversation];
      activeRecord.status = "streaming";
      await saveRecord();

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
  sendResponse: (response: PronunciationResponse | ConnectionTestResponse | PublicSettingsResponse | SpeechActionResponse) => void
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

    if (message.type === "SPEECH_REPLAY") {
      if (typeof message.requestId !== "string" || !message.requestId || message.requestId.length > 100) {
        sendResponse({ ok: false, message: "语音解释请求无效。" });
        return;
      }

      try {
        if (replayableSpeech?.requestId === message.requestId) {
          await ensureOffscreenDocument();
          const result = await chrome.runtime.sendMessage({
            target: "offscreen-audio",
            type: "REPLAY_STREAM",
            requestId: message.requestId
          }) as SpeechActionResponse | undefined;
          sendResponse(result?.ok ? result : { ok: false, message: "当前语音解释已不可重听。" });
          return;
        }

        if (await chrome.offscreen.hasDocument()) {
          const result = await chrome.runtime.sendMessage({
            target: "offscreen-audio",
            type: "REPLAY_STREAM",
            requestId: message.requestId
          }) as SpeechActionResponse | undefined;
          sendResponse(result?.ok ? result : { ok: false, message: "当前语音解释已不可重听。" });
          return;
        }

        sendResponse({ ok: false, message: "当前语音解释已不可重听。" });
      } catch (error) {
        sendResponse({
          ok: false,
          message: error instanceof Error ? error.message : "重听语音解释失败。"
        });
      }
      return;
    }

    if (message.type === "SPEECH_CANCEL") {
      if (typeof message.requestId === "string" && message.requestId.length <= 100) {
        cancelledSpeechRequestIds.add(message.requestId);
        setTimeout(() => cancelledSpeechRequestIds.delete(message.requestId), 30000);
        if (latestSpeechLookupRequestId === message.requestId) latestSpeechLookupRequestId = "";
        await cancelSpeechSession(message.requestId);
      }
      sendResponse({ ok: true });
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
            message: "有道词典英式音标查询成功。"
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
