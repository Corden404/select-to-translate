import type { PronunciationResponse } from "../shared/messages";
import {
  promptsForKind,
  type LookupSettings,
  type UiFontSize,
  type UiTheme
} from "../shared/settings";
import type { AnchorPoint } from "./anchor";
import type { ExtractedContext } from "./context-extractor";
import type { ClassifiedSelection } from "../shared/selection";

const HOST_ID = "__selection_lookup_root__";

export interface CardQuery {
  selection: ClassifiedSelection;
  context: ExtractedContext;
}

interface FloatingCardCallbacks {
  onRegenerate?: (query: CardQuery, promptId: string) => void;
  onPromptChange?: (query: CardQuery, promptId: string) => void;
  onFollowUp?: (message: string) => void;
  onPronounce?: (word: string) => Promise<PronunciationResponse>;
  onDismiss?: () => void;
}

export class FloatingCard {
  private host: HTMLDivElement;
  private shadow: ShadowRoot;
  private card: HTMLDivElement;
  private body: HTMLDivElement;
  private status: HTMLSpanElement;
  private pinButton: HTMLButtonElement;
  private promptSelect: HTMLSelectElement;
  private pronunciationRow: HTMLDivElement;
  private pronunciationText: HTMLSpanElement;
  private pronunciationButton: HTMLButtonElement;
  private followUpButton: HTMLButtonElement;
  private chatPanel: HTMLDivElement;
  private chatMessages: HTMLDivElement;
  private chatInput: HTMLTextAreaElement;
  private sendButton: HTMLButtonElement;
  private anchor: AnchorPoint | null = null;
  private lastQuery: CardQuery | null = null;
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
        .kind { padding:2px 8px; border-radius:999px; background:var(--accent-soft); font-size:.75em; font-weight:750; }
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
          <span class="kind"></span><span class="status">准备查询</span>
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
        </div>
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
    this.promptSelect = this.shadow.querySelector(".prompt") as HTMLSelectElement;
    this.pronunciationRow = this.shadow.querySelector(".pronunciation") as HTMLDivElement;
    this.pronunciationText = this.shadow.querySelector(".phonetic") as HTMLSpanElement;
    this.pronunciationButton = this.shadow.querySelector(".speak") as HTMLButtonElement;
    this.followUpButton = this.shadow.querySelector(".follow-up") as HTMLButtonElement;
    this.chatPanel = this.shadow.querySelector(".chat") as HTMLDivElement;
    this.chatMessages = this.shadow.querySelector(".messages") as HTMLDivElement;
    this.chatInput = this.shadow.querySelector(".chat-input") as HTMLTextAreaElement;
    this.sendButton = this.shadow.querySelector(".send") as HTMLButtonElement;

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
    this.followUpButton.addEventListener("click", () => this.openChat());
    this.sendButton.addEventListener("click", () => this.submitFollowUp());
    this.chatInput.addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        this.submitFollowUp();
      }
    });
    this.pronunciationButton.addEventListener("click", () => void this.playPronunciation());

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

  setAppearance(settings: LookupSettings["ui"]): void {
    this.themePreference = settings.theme;
    this.applyResolvedTheme();
    const sizes: Record<UiFontSize,string> = { small:"13px", medium:"15px", large:"17px" };
    this.card.style.setProperty("--lookup-font-size", sizes[settings.fontSize]);
  }

  show(query: CardQuery, anchor: AnchorPoint, settings: LookupSettings, promptId?: string): void {
    this.lastQuery = query;
    this.anchor = anchor;
    this.host.style.display = "block";
    this.resetChat();

    const kind = this.shadow.querySelector(".kind") as HTMLSpanElement;
    const selected = this.shadow.querySelector(".selected") as HTMLDivElement;
    const context = this.shadow.querySelector(".context") as HTMLDivElement;
    kind.textContent = query.selection.kind === "word" ? "单词" : "句子";
    selected.textContent = query.selection.text;
    context.textContent = query.selection.kind === "word"
      ? `语境：${query.context.currentSentence}`
      : `上下文：${[query.context.previousSentence,query.context.currentSentence,query.context.nextSentence].filter(Boolean).join(" ")}`;

    const prompts = promptsForKind(settings, query.selection.kind);
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
    this.appendBubble("user", message);
    this.chatInput.value = "";
    this.callbacks.onFollowUp?.(message);
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
