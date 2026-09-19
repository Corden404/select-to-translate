import type {
  PronunciationResponse,
  SpeechActionResponse,
  SpeechLatencyReport
} from "../shared/messages";
import {
  publicPromptsForKind,
  type PublicLookupSettings,
  type UiFontSize,
  type UiTheme
} from "../shared/settings";
import type { AnchorPoint } from "./anchor";
import type { ExtractedContext } from "./context-extractor";
import type { ClassifiedSelection, SelectionKind } from "../shared/selection";

const HOST_ID = "__selection_lookup_root__";

export interface CardQuery {
  selection: ClassifiedSelection;
  context: ExtractedContext;
  sentenceContext?: ExtractedContext;
}

interface FloatingCardCallbacks {
  onRegenerate?: (query: CardQuery, promptId: string) => void;
  onPromptChange?: (query: CardQuery, promptId: string) => void;
  onKindChange?: (query: CardQuery, promptId: string) => void;
  onFollowUp?: (message: string) => boolean;
  onPronounce?: (word: string) => Promise<PronunciationResponse>;
  onReplaySpeech?: () => Promise<SpeechActionResponse>;
  onDismiss?: () => void;
}

export class FloatingCard {
  private host: HTMLDivElement;
  private shadow: ShadowRoot;
  private card: HTMLDivElement;
  private body: HTMLDivElement;
  private status: HTMLSpanElement;
  private pinButton: HTMLButtonElement;
  private kindSelect: HTMLSelectElement;
  private promptSelect: HTMLSelectElement;
  private pronunciationRow: HTMLDivElement;
  private pronunciationText: HTMLSpanElement;
  private pronunciationButton: HTMLButtonElement;
  private speechReplayButton: HTMLButtonElement;
  private followUpButton: HTMLButtonElement;
  private chatPanel: HTMLDivElement;
  private chatMessages: HTMLDivElement;
  private chatInput: HTMLTextAreaElement;
  private sendButton: HTMLButtonElement;
  private latencyDetails: HTMLDetailsElement;
  private latencySummary: HTMLElement;
  private latencyBody: HTMLDivElement;
  private anchor: AnchorPoint | null = null;
  private lastQuery: CardQuery | null = null;
  private publicSettings: PublicLookupSettings | null = null;
  private pinned = false;
  private themePreference: UiTheme = "dark";
  private initialResponseText = "";
  private chatAssistantBubble: HTMLDivElement | null = null;
  private readonly callbacks: FloatingCardCallbacks;
  private readonly darkMedia = window.matchMedia("(prefers-color-scheme: dark)");

  constructor(callbacks: FloatingCardCallbacks = {}) {
    this.callbacks = callbacks;
    document.getElementById(HOST_ID)?.remove();

    this.host = document.createElement("div");
    this.host.id = HOST_ID;
    this.host.style.all = "initial";
    this.host.style.position = "fixed";
    this.host.style.inset = "0";
    this.host.style.zIndex = "2147483647";
    this.host.style.pointerEvents = "none";
    this.host.style.display = "none";

    this.shadow = this.host.attachShadow({ mode: "open" });
    this.shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .card {
          --bg: rgba(20,20,23,.985); --bg-soft:#25252a; --bg-hover:#303038;
          --text:#f3f3f5; --muted:#9b9ba5; --border:rgba(255,255,255,.10);
          --accent:#8b7cf6; --accent-soft:rgba(139,124,246,.18);
          position:fixed; width:min(400px,calc(100vw - 24px)); max-height:min(500px,calc(100vh - 24px));
          overflow:auto; box-sizing:border-box; padding:13px; border:1px solid var(--border);
          border-radius:14px; background:var(--bg); color:var(--text);
          box-shadow:0 18px 46px rgba(0,0,0,.48);
          font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei UI",sans-serif;
          font-size:var(--lookup-font-size,15px); line-height:1.62; pointer-events:auto;
          backdrop-filter:blur(18px); color-scheme:dark;
        }
        .card.chat-mode { width:min(520px,calc(100vw - 24px)); max-height:min(640px,calc(100vh - 24px)); }
        .card[data-theme="light"] {
          --bg:rgba(252,252,253,.985); --bg-soft:#f1f1f4; --bg-hover:#e7e7ec;
          --text:#1c1c20; --muted:#777780; --border:rgba(0,0,0,.10);
          --accent:#6657d9; --accent-soft:rgba(102,87,217,.12);
          box-shadow:0 14px 38px rgba(0,0,0,.18); color-scheme:light;
        }
        .header { display:flex; align-items:center; gap:8px; margin-bottom:10px; }
        .kind { padding:3px 7px; border:1px solid var(--border); border-radius:999px; background:var(--accent-soft); color:var(--text); font-size:.75em; font-weight:750; }
        .status { flex:1; min-width:0; color:var(--muted); font-size:.76em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        button, select, textarea { font:inherit; }
        button { border:0; border-radius:8px; padding:5px 9px; background:var(--bg-soft); color:var(--text); cursor:pointer; }
        button:hover { background:var(--bg-hover); } button:disabled { cursor:default; opacity:.45; }
        .icon { width:32px; height:32px; padding:0; display:inline-grid; place-items:center; font-size:15px; line-height:1; }
        .pin[aria-pressed="true"] { background:var(--accent-soft); box-shadow:inset 0 0 0 1px var(--accent); }
        .selected { margin:0 0 5px; font-size:1.08em; font-weight:720; overflow-wrap:anywhere; }
        .pronunciation { display:none; align-items:center; gap:7px; margin-bottom:8px; color:var(--muted); font-size:.82em; }
        .pronunciation.visible { display:flex; }
        .body { min-height:22px; white-space:pre-wrap; overflow-wrap:anywhere; }
        .body.error { color:#ff8e8e; }
        .context { margin-top:11px; padding-top:9px; border-top:1px solid var(--border); color:var(--muted); font-size:.78em; white-space:pre-wrap; overflow-wrap:anywhere; }
        .toolbar { display:flex; align-items:center; gap:7px; margin-top:11px; flex-wrap:wrap; }
        .speech-replay { display:none; } .speech-replay.visible { display:inline-block; }
        .latency { display:none; margin-top:9px; padding-top:8px; border-top:1px dashed var(--border); color:var(--muted); font-size:.76em; }
        .latency.visible { display:block; }
        .latency summary { cursor:pointer; color:var(--text); }
        .latency-body { margin-top:5px; white-space:pre-wrap; line-height:1.55; }
        .prompt { min-width:140px; max-width:210px; padding:5px 7px; border:1px solid var(--border); border-radius:8px; background:var(--bg-soft); color:var(--text); }
        .chat { display:none; margin-top:12px; padding-top:10px; border-top:1px solid var(--border); }
        .chat.visible { display:block; }
        .messages { display:flex; flex-direction:column; gap:8px; max-height:260px; overflow:auto; padding-right:2px; }
        .bubble { padding:8px 10px; border-radius:10px; white-space:pre-wrap; overflow-wrap:anywhere; }
        .bubble.user { align-self:flex-end; max-width:85%; background:var(--accent-soft); }
        .bubble.assistant { align-self:stretch; background:var(--bg-soft); }
        .composer { display:grid; grid-template-columns:1fr auto; gap:7px; margin-top:9px; align-items:end; }
        .composer textarea { min-height:42px; max-height:110px; resize:vertical; border:1px solid var(--border); border-radius:9px; padding:8px; background:var(--bg-soft); color:var(--text); outline:none; }
      </style>
      <div class="card" data-theme="dark" role="dialog" aria-label="查词结果">
        <div class="header">
          <select class="kind" aria-label="解释模式">
            <option value="word">词 / 词组</option>
            <option value="sentence">句子</option>
          </select>
          <span class="status">准备查询</span>
          <button class="icon pin" type="button" aria-label="固定窗口" aria-pressed="false" title="固定窗口">📌</button>
          <button class="icon close" type="button" aria-label="关闭" title="关闭">×</button>
        </div>
        <div class="selected"></div>
        <div class="pronunciation"><span class="phonetic"></span><button class="speak" type="button">🔊 英音</button></div>
        <div class="body"></div>
        <div class="context"></div>
        <div class="toolbar">
          <select class="prompt" aria-label="Prompt"></select>
          <button class="regenerate" type="button">重新生成</button>
          <button class="follow-up" type="button" disabled>继续追问</button>
          <button class="speech-replay" type="button" disabled>🔁 重听讲解</button>
        </div>
        <details class="latency"><summary>语音延迟分析</summary><div class="latency-body"></div></details>
        <div class="chat">
          <div class="messages"></div>
          <div class="composer">
            <textarea class="chat-input" placeholder="继续追问…"></textarea>
            <button class="send" type="button">发送</button>
          </div>
        </div>
      </div>
    `;

    this.card = this.shadow.querySelector(".card") as HTMLDivElement;
    this.body = this.shadow.querySelector(".body") as HTMLDivElement;
    this.status = this.shadow.querySelector(".status") as HTMLSpanElement;
    this.pinButton = this.shadow.querySelector(".pin") as HTMLButtonElement;
    this.kindSelect = this.shadow.querySelector(".kind") as HTMLSelectElement;
    this.promptSelect = this.shadow.querySelector(".prompt") as HTMLSelectElement;
    this.pronunciationRow = this.shadow.querySelector(".pronunciation") as HTMLDivElement;
    this.pronunciationText = this.shadow.querySelector(".phonetic") as HTMLSpanElement;
    this.pronunciationButton = this.shadow.querySelector(".speak") as HTMLButtonElement;
    this.speechReplayButton = this.shadow.querySelector(".speech-replay") as HTMLButtonElement;
    this.followUpButton = this.shadow.querySelector(".follow-up") as HTMLButtonElement;
    this.chatPanel = this.shadow.querySelector(".chat") as HTMLDivElement;
    this.chatMessages = this.shadow.querySelector(".messages") as HTMLDivElement;
    this.chatInput = this.shadow.querySelector(".chat-input") as HTMLTextAreaElement;
    this.sendButton = this.shadow.querySelector(".send") as HTMLButtonElement;
    this.latencyDetails = this.shadow.querySelector(".latency") as HTMLDetailsElement;
    this.latencySummary = this.latencyDetails.querySelector("summary") as HTMLElement;
    this.latencyBody = this.shadow.querySelector(".latency-body") as HTMLDivElement;

    this.shadow.querySelector(".close")?.addEventListener("click", () => {
      this.setPinned(false);
      this.hide();
    });
    this.pinButton.addEventListener("click", () => this.setPinned(!this.pinned));
    this.shadow.querySelector(".regenerate")?.addEventListener("click", () => {
      if (this.lastQuery) this.callbacks.onRegenerate?.(this.lastQuery, this.promptSelect.value);
    });
    this.promptSelect.addEventListener("change", () => {
      if (this.lastQuery) this.callbacks.onPromptChange?.(this.lastQuery, this.promptSelect.value);
    });
    this.kindSelect.addEventListener("change", () => {
      this.changeKind(this.kindSelect.value as SelectionKind);
    });
    this.followUpButton.addEventListener("click", () => this.openChat());
    this.sendButton.addEventListener("click", () => this.submitFollowUp());
    this.chatInput.addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        this.submitFollowUp();
      }
    });
    this.pronunciationButton.addEventListener("click", () => void this.playPronunciation());
    this.speechReplayButton.addEventListener("click", () => void this.replaySpeechExplanation());

    this.darkMedia.addEventListener("change", () => {
      if (this.themePreference === "system") this.applyResolvedTheme();
    });
    document.documentElement.appendChild(this.host);
  }

  containsEvent(event: Event): boolean { return event.composedPath().includes(this.host); }

  handleOutsidePointerDown(event: PointerEvent): void {
    if (!this.isVisible() || this.pinned || this.containsEvent(event)) return;
    this.hide();
  }

  setAppearance(settings: PublicLookupSettings["ui"]): void {
    this.themePreference = settings.theme;
    this.applyResolvedTheme();
    const sizes: Record<UiFontSize,string> = { small:"13px", medium:"15px", large:"17px" };
    this.card.style.setProperty("--lookup-font-size", sizes[settings.fontSize]);
  }

  show(query: CardQuery, anchor: AnchorPoint, settings: PublicLookupSettings, promptId?: string): void {
    this.lastQuery = query;
    this.anchor = anchor;
    this.publicSettings = settings;
    this.host.style.display = "block";
    this.resetChat();

    const selected = this.shadow.querySelector(".selected") as HTMLDivElement;
    const context = this.shadow.querySelector(".context") as HTMLDivElement;
    this.kindSelect.value = query.selection.kind;
    selected.textContent = query.selection.text;
    context.textContent = query.selection.kind === "word"
      ? `语境：${query.context.currentSentence}`
      : `上下文：${[query.context.previousSentence,query.context.currentSentence,query.context.nextSentence].filter(Boolean).join(" ")}`;

    const prompts = publicPromptsForKind(settings, query.selection.kind);
    this.promptSelect.replaceChildren(...prompts.map(prompt => {
      const option = document.createElement("option");
      option.value = prompt.id;
      option.textContent = prompt.name;
      return option;
    }));
    const defaultId = query.selection.kind === "word"
      ? settings.prompts.defaultWordPromptId
      : settings.prompts.defaultSentencePromptId;
    this.promptSelect.value = prompts.some(item => item.id === promptId) ? promptId! : defaultId;
    if (!this.promptSelect.value && prompts[0]) this.promptSelect.value = prompts[0].id;

    this.body.classList.remove("error");
    this.body.textContent = "";
    this.status.textContent = "准备查询";
    this.followUpButton.disabled = true;
    this.initialResponseText = "";
    const speechReplayVisible = query.selection.kind === "word" && settings.speechExplanation.enabled;
    this.speechReplayButton.classList.toggle("visible", speechReplayVisible);
    this.speechReplayButton.disabled = true;
    this.latencyDetails.classList.remove("visible");
    this.latencyDetails.open = false;
    this.latencySummary.textContent = "语音延迟分析";
    this.latencyBody.textContent = "";
    const pronunciationVisible = query.selection.kind === "word"
      && settings.pronunciation.provider !== "off";
    this.pronunciationRow.classList.toggle("visible", pronunciationVisible);
    if (pronunciationVisible && settings.pronunciation.provider === "mimo") {
      this.pronunciationText.textContent = `MiMo TTS · ${settings.pronunciation.mimo.voice} · 英式风格`;
      this.pronunciationButton.textContent = "🔊 MiMo";
    } else if (pronunciationVisible) {
      this.pronunciationText.textContent = "有道词典 · 英音";
      this.pronunciationButton.textContent = "🔊 英音";
    } else {
      this.pronunciationText.textContent = "";
    }
    this.position();
    requestAnimationFrame(() => this.position());
  }

  beginLoading(): void {
    this.body.classList.remove("error");
    this.body.textContent = "";
    this.initialResponseText = "";
    this.followUpButton.disabled = true;
    this.status.textContent = "正在连接模型…";
    this.speechReplayButton.disabled = true;
    this.position();
  }

  appendChunk(text: string): void {
    if (!text) return;
    this.status.textContent = "正在生成…";
    this.body.classList.remove("error");
    this.body.textContent += text;
    this.initialResponseText += text;
    this.position();
  }

  complete(): void {
    this.status.textContent = "完成";
    this.followUpButton.disabled = false;
    this.position();
  }

  showError(message: string): void {
    this.status.textContent = "请求失败";
    this.body.classList.add("error");
    this.body.textContent = message;
    this.followUpButton.disabled = true;
    this.position();
  }

  chatStarted(): void {
    this.sendButton.disabled = true;
    this.chatInput.disabled = true;
    this.chatAssistantBubble = this.appendBubble("assistant", "");
  }

  appendChatChunk(text: string): void {
    if (!this.chatAssistantBubble) this.chatAssistantBubble = this.appendBubble("assistant", "");
    this.chatAssistantBubble.textContent += text;
    this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
  }

  chatDone(): void {
    this.sendButton.disabled = false;
    this.chatInput.disabled = false;
    this.chatAssistantBubble = null;
    this.chatInput.focus();
  }

  chatError(message: string): void {
    this.sendButton.disabled = false;
    this.chatInput.disabled = false;
    this.chatAssistantBubble = null;
    this.appendBubble("assistant", message);
    this.chatInput.focus();
  }

  hide(): void {
    if (!this.isVisible()) return;
    this.host.style.display = "none";
    this.callbacks.onDismiss?.();
  }

  isVisible(): boolean { return this.host.style.display !== "none"; }
  reposition(): void { if (this.isVisible()) this.position(); }

  setActivePrompt(promptId: string): void {
    if ([...this.promptSelect.options].some(option => option.value === promptId)) {
      this.promptSelect.value = promptId;
    }
  }

  setSpeechReplayReady(ready: boolean): void {
    if (!this.speechReplayButton.classList.contains("visible")) return;
    this.speechReplayButton.disabled = !ready;
  }

  setSpeechLatency(report: SpeechLatencyReport): void {
    const localMs = report.audioStartMs;
    const stages = [
      { label: "触发/后台准备", value: report.triggerToWorkerMs + report.workerPrepMs },
      { label: "语音 LLM", value: report.llmTotalMs },
      { label: "MiMo TTS 首 chunk", value: report.ttsFirstChunkMs },
      { label: "首 chunk→播放", value: localMs }
    ];
    const bottleneck = stages.reduce((largest, stage) => stage.value > largest.value ? stage : largest);
    const ttsStages = [
      { label: "等待响应头", value: report.ttsHeadersMs },
      { label: "响应头→首音频 chunk", value: report.ttsFirstAudioAfterHeadersMs }
    ];
    const ttsBottleneck = ttsStages.reduce((largest, stage) => stage.value > largest.value ? stage : largest);
    const seconds = (ms: number) => `${(ms / 1000).toFixed(ms >= 1000 ? 2 : 3)}s`;
    const bytes = (value: number) => value >= 1024 * 1024
      ? `${(value / 1024 / 1024).toFixed(2)} MB`
      : `${(value / 1024).toFixed(1)} KB`;
    const bottleneckText = bottleneck.label === "MiMo TTS 首 chunk"
      ? `${bottleneck.label} ${seconds(bottleneck.value)}（${ttsBottleneck.label} ${seconds(ttsBottleneck.value)}）`
      : `${bottleneck.label} ${seconds(bottleneck.value)}`;

    this.latencySummary.textContent = `语音延迟 ${seconds(report.totalMs)} · 瓶颈：${bottleneckText}`;
    this.latencyBody.textContent = [
      `选词→后台：${seconds(report.triggerToWorkerMs)}`,
      `后台准备：${seconds(report.workerPrepMs)}`,
      `LLM 首 token：${seconds(report.llmTtftMs)}`,
      `LLM 后续生成：${seconds(report.llmGenerationMs)}`,
      `LLM 总计：${seconds(report.llmTotalMs)}`,
      `MiMo TTS 首 chunk：${seconds(report.ttsFirstChunkMs)}`,
      `  ↳ 等待响应头：${seconds(report.ttsHeadersMs)}`,
      `  ↳ 响应头→首音频 chunk：${seconds(report.ttsFirstAudioAfterHeadersMs)}`,
      `TTS 首 chunk 后剩余流：${seconds(report.ttsRemainingStreamMs)}`,
      `TTS 完整流：${seconds(report.ttsMs)}`,
      `SSE/JSON 解析累计：${seconds(report.ttsParseMs)}`,
      `音频 chunk 数：${report.ttsChunkCount}`,
      `语音稿长度：${report.speechChars} 字符`,
      `流式响应体：${bytes(report.ttsResponseBytes)}`,
      `PCM 音频数据：${bytes(report.audioBytes)}`,
      `offscreen 准备：${seconds(report.offscreenReadyMs)}`,
      `播放器首音：${seconds(report.audioStartMs)}`,
      `总首音延迟：${seconds(report.totalMs)}`
    ].join("\n");
    this.latencyDetails.classList.add("visible");
    this.position();
  }

  private async replaySpeechExplanation(): Promise<void> {
    if (!this.callbacks.onReplaySpeech || this.speechReplayButton.disabled) return;
    this.speechReplayButton.disabled = true;
    let canReplayAgain = false;
    try {
      const result = await this.callbacks.onReplaySpeech();
      if (!result.ok) {
        this.status.textContent = result.message ?? "当前语音解释已不可重听";
        return;
      }
      canReplayAgain = true;
    } catch (error) {
      this.status.textContent = error instanceof Error ? error.message : "重听语音解释失败";
    } finally {
      if (canReplayAgain && this.speechReplayButton.classList.contains("visible")) {
        this.speechReplayButton.disabled = false;
      }
    }
  }

  private async playPronunciation(): Promise<void> {
    await this.fetchAndPlayPronunciation(true);
  }

  private async fetchAndPlayPronunciation(play: boolean): Promise<void> {
    const word = this.lastQuery?.selection.text;
    if (!word || !this.callbacks.onPronounce) return;
    this.pronunciationButton.disabled = true;
    try {
      const result = await this.callbacks.onPronounce(word);
      if (!result.ok) {
        this.pronunciationText.textContent = result.message ?? "发音不可用";
        return;
      }
      this.pronunciationText.textContent = result.phonetic
        ? `英式 / ${result.phonetic} /${result.label ? " · " + result.label : ""}`
        : result.label ?? "英式发音";
      if (play && result.audioDataUrl) {
        await new Audio(result.audioDataUrl).play();
      } else if (play && !result.audioDataUrl) {
        this.pronunciationText.textContent += " · 暂无音频";
      }
    } catch (error) {
      this.pronunciationText.textContent = error instanceof Error ? error.message : "发音查询失败";
    } finally {
      this.pronunciationButton.disabled = false;
    }
  }

  private openChat(): void {
    this.card.classList.add("chat-mode");
    this.chatPanel.classList.add("visible");
    if (this.chatMessages.childElementCount === 0 && this.initialResponseText) {
      this.appendBubble("assistant", this.initialResponseText);
    }
    this.chatInput.focus();
    this.position();
  }

  private submitFollowUp(): void {
    const message = this.chatInput.value.trim();
    if (!message || this.sendButton.disabled) return;
    this.openChat();
    this.sendButton.disabled = true;
    this.chatInput.disabled = true;
    this.appendBubble("user", message);
    this.chatInput.value = "";
    const accepted = this.callbacks.onFollowUp?.(message) ?? false;
    if (!accepted) {
      this.chatError("当前会话已经结束，请重新选择文本。");
    }
  }

  private changeKind(kind: SelectionKind): void {
    if (!this.lastQuery || !this.anchor || !this.publicSettings || this.lastQuery.selection.kind === kind) {
      return;
    }
    const sentenceContext = this.lastQuery.sentenceContext ?? this.lastQuery.context;
    const context = kind === "sentence"
      ? sentenceContext
      : {
          currentSentence: sentenceContext.currentSentence,
          quality: sentenceContext.quality
        };
    const query: CardQuery = {
      selection: { ...this.lastQuery.selection, kind },
      context,
      sentenceContext
    };
    const anchor = this.anchor;
    const settings = this.publicSettings;
    this.show(query, anchor, settings);
    this.callbacks.onKindChange?.(query, this.promptSelect.value);
  }

  private appendBubble(role: "user" | "assistant", text: string): HTMLDivElement {
    const bubble = document.createElement("div");
    bubble.className = `bubble ${role}`;
    bubble.textContent = text;
    this.chatMessages.appendChild(bubble);
    this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
    return bubble;
  }

  private resetChat(): void {
    this.card.classList.remove("chat-mode");
    this.chatPanel.classList.remove("visible");
    this.chatMessages.replaceChildren();
    this.chatInput.value = "";
    this.chatInput.disabled = false;
    this.sendButton.disabled = false;
    this.chatAssistantBubble = null;
  }

  private setPinned(pinned: boolean): void {
    this.pinned = pinned;
    this.pinButton.setAttribute("aria-pressed", String(pinned));
    this.pinButton.title = pinned ? "取消固定" : "固定窗口";
  }

  private applyResolvedTheme(): void {
    const theme = this.themePreference === "system"
      ? (this.darkMedia.matches ? "dark" : "light")
      : this.themePreference;
    this.card.dataset.theme = theme;
  }

  private position(): void {
    if (!this.anchor) return;
    const margin=10, viewportPadding=12, rect=this.card.getBoundingClientRect();
    let left=this.anchor.left+this.anchor.width/2-rect.width/2;
    left=Math.max(viewportPadding,Math.min(left,window.innerWidth-rect.width-viewportPadding));
    let top=this.anchor.bottom+margin;
    if (top+rect.height>window.innerHeight-viewportPadding) {
      top=Math.max(viewportPadding,this.anchor.top-rect.height-margin);
    }
    this.card.style.left=`${Math.round(left)}px`;
    this.card.style.top=`${Math.round(top)}px`;
  }
}
