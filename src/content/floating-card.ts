import type { LookupSettings, UiFontSize, UiTheme } from "../shared/settings";
import type { AnchorPoint } from "./anchor";
import type { ExtractedContext } from "./context-extractor";
import type { ClassifiedSelection } from "../shared/selection";

const HOST_ID = "__selection_lookup_root__";

export interface CardQuery {
  selection: ClassifiedSelection;
  context: ExtractedContext;
}

interface FloatingCardCallbacks {
  onRegenerate?: (query: CardQuery) => void;
  onDismiss?: () => void;
}

export class FloatingCard {
  private host: HTMLDivElement;
  private shadow: ShadowRoot;
  private card: HTMLDivElement;
  private body: HTMLDivElement;
  private status: HTMLSpanElement;
  private pinButton: HTMLButtonElement;
  private anchor: AnchorPoint | null = null;
  private lastQuery: CardQuery | null = null;
  private pinned = false;
  private themePreference: UiTheme = "dark";
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

    this.shadow = this.host.attachShadow({ mode: "closed" });
    this.shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .card {
          --bg: rgba(20, 20, 23, .985);
          --bg-soft: #25252a;
          --bg-hover: #303038;
          --text: #f3f3f5;
          --muted: #9b9ba5;
          --border: rgba(255, 255, 255, .10);
          --accent: #8b7cf6;
          --accent-soft: rgba(139, 124, 246, .18);
          position: fixed;
          width: min(390px, calc(100vw - 24px));
          max-height: min(460px, calc(100vh - 24px));
          overflow: auto;
          box-sizing: border-box;
          padding: 13px;
          border: 1px solid var(--border);
          border-radius: 14px;
          background: var(--bg);
          color: var(--text);
          box-shadow: 0 18px 46px rgba(0, 0, 0, .48);
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei UI", sans-serif;
          font-size: var(--lookup-font-size, 15px);
          line-height: 1.62;
          pointer-events: auto;
          backdrop-filter: blur(18px);
          color-scheme: dark;
        }
        .card[data-theme="light"] {
          --bg: rgba(252, 252, 253, .985);
          --bg-soft: #f1f1f4;
          --bg-hover: #e7e7ec;
          --text: #1c1c20;
          --muted: #777780;
          --border: rgba(0, 0, 0, .10);
          --accent: #6657d9;
          --accent-soft: rgba(102, 87, 217, .12);
          box-shadow: 0 14px 38px rgba(0, 0, 0, .18);
          color-scheme: light;
        }
        .header {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 10px;
        }
        .kind {
          padding: 2px 8px;
          border-radius: 999px;
          background: var(--accent-soft);
          color: var(--text);
          font-size: .75em;
          font-weight: 750;
          letter-spacing: .03em;
        }
        .status {
          flex: 1;
          min-width: 0;
          color: var(--muted);
          font-size: .76em;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        button {
          border: 0;
          border-radius: 8px;
          padding: 5px 9px;
          background: var(--bg-soft);
          color: var(--text);
          font: inherit;
          cursor: pointer;
        }
        button:hover { background: var(--bg-hover); }
        button:disabled { cursor: default; opacity: .45; }
        .icon {
          width: 32px;
          height: 32px;
          padding: 0;
          display: inline-grid;
          place-items: center;
          font-size: 15px;
          line-height: 1;
        }
        .pin[aria-pressed="true"] {
          background: var(--accent-soft);
          box-shadow: inset 0 0 0 1px var(--accent);
        }
        .selected {
          margin: 0 0 8px;
          font-size: 1.08em;
          font-weight: 720;
          overflow-wrap: anywhere;
        }
        .body {
          min-height: 22px;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }
        .body.error { color: #ff8e8e; }
        .context {
          margin-top: 11px;
          padding-top: 9px;
          border-top: 1px solid var(--border);
          color: var(--muted);
          font-size: .78em;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }
        .actions {
          display: flex;
          gap: 7px;
          margin-top: 11px;
        }
      </style>
      <div class="card" data-theme="dark" role="dialog" aria-label="查词结果">
        <div class="header">
          <span class="kind"></span>
          <span class="status">准备查询</span>
          <button class="icon pin" type="button" aria-label="固定窗口" aria-pressed="false" title="固定窗口">📌</button>
          <button class="icon close" type="button" aria-label="关闭" title="关闭">×</button>
        </div>
        <div class="selected"></div>
        <div class="body"></div>
        <div class="context"></div>
        <div class="actions">
          <button class="regenerate" type="button">重新生成</button>
          <button class="follow-up" type="button" disabled title="后续版本开放">继续追问</button>
        </div>
      </div>
    `;

    this.card = this.shadow.querySelector(".card") as HTMLDivElement;
    this.body = this.shadow.querySelector(".body") as HTMLDivElement;
    this.status = this.shadow.querySelector(".status") as HTMLSpanElement;
    this.pinButton = this.shadow.querySelector(".pin") as HTMLButtonElement;

    this.shadow.querySelector(".close")?.addEventListener("click", () => {
      this.setPinned(false);
      this.hide();
    });
    this.pinButton.addEventListener("click", () => this.setPinned(!this.pinned));
    this.shadow.querySelector(".regenerate")?.addEventListener("click", () => {
      if (this.lastQuery) this.callbacks.onRegenerate?.(this.lastQuery);
    });

    this.darkMedia.addEventListener("change", () => {
      if (this.themePreference === "system") this.applyResolvedTheme();
    });

    document.documentElement.appendChild(this.host);
  }

  containsEvent(event: Event): boolean {
    return event.composedPath().includes(this.host);
  }

  handleOutsidePointerDown(event: PointerEvent): void {
    if (!this.isVisible() || this.pinned || this.containsEvent(event)) return;
    this.hide();
  }

  setAppearance(settings: LookupSettings["ui"]): void {
    this.themePreference = settings.theme;
    this.applyResolvedTheme();

    const fontSize: Record<UiFontSize, string> = {
      small: "13px",
      medium: "15px",
      large: "17px"
    };
    this.card.style.setProperty("--lookup-font-size", fontSize[settings.fontSize]);
  }

  show(query: CardQuery, anchor: AnchorPoint): void {
    this.lastQuery = query;
    this.anchor = anchor;
    this.host.style.display = "block";

    const kind = this.shadow.querySelector(".kind") as HTMLSpanElement;
    const selected = this.shadow.querySelector(".selected") as HTMLDivElement;
    const context = this.shadow.querySelector(".context") as HTMLDivElement;

    kind.textContent = query.selection.kind === "word" ? "单词" : "句子";
    selected.textContent = query.selection.text;
    context.textContent = query.selection.kind === "word"
      ? `语境：${query.context.currentSentence}`
      : `上下文：${[
          query.context.previousSentence,
          query.context.currentSentence,
          query.context.nextSentence
        ].filter(Boolean).join(" ")}`;

    this.body.classList.remove("error");
    this.body.textContent = "";
    this.status.textContent = "准备查询";

    this.position();
    requestAnimationFrame(() => this.position());
  }

  beginLoading(): void {
    this.body.classList.remove("error");
    this.body.textContent = "";
    this.status.textContent = "正在连接模型…";
    this.position();
  }

  appendChunk(text: string): void {
    if (!text) return;
    this.status.textContent = "正在生成…";
    this.body.classList.remove("error");
    this.body.textContent += text;
    this.position();
  }

  complete(): void {
    this.status.textContent = "完成";
    this.position();
  }

  showError(message: string): void {
    this.status.textContent = "请求失败";
    this.body.classList.add("error");
    this.body.textContent = message;
    this.position();
  }

  hide(): void {
    if (!this.isVisible()) return;
    this.host.style.display = "none";
    this.callbacks.onDismiss?.();
  }

  isVisible(): boolean {
    return this.host.style.display !== "none";
  }

  reposition(): void {
    if (this.isVisible()) this.position();
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

    const margin = 10;
    const viewportPadding = 12;
    const cardRect = this.card.getBoundingClientRect();

    let left = this.anchor.left + this.anchor.width / 2 - cardRect.width / 2;
    left = Math.max(
      viewportPadding,
      Math.min(left, window.innerWidth - cardRect.width - viewportPadding)
    );

    let top = this.anchor.bottom + margin;
    if (top + cardRect.height > window.innerHeight - viewportPadding) {
      top = Math.max(viewportPadding, this.anchor.top - cardRect.height - margin);
    }

    this.card.style.left = `${Math.round(left)}px`;
    this.card.style.top = `${Math.round(top)}px`;
  }
}
