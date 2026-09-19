import type { AnchorPoint } from "./anchor";
import type { ExtractedContext } from "./context-extractor";
import type { ClassifiedSelection } from "../shared/selection";

const HOST_ID = "__selection_lookup_root__";

export interface CardQuery {
  selection: ClassifiedSelection;
  context: ExtractedContext;
}

export class FloatingCard {
  private host: HTMLDivElement;
  private shadow: ShadowRoot;
  private card: HTMLDivElement;
  private body: HTMLDivElement;
  private status: HTMLSpanElement;
  private streamTimer: number | null = null;
  private streamToken = 0;
  private anchor: AnchorPoint | null = null;

  constructor() {
    document.getElementById(HOST_ID)?.remove();

    this.host = document.createElement("div");
    this.host.id = HOST_ID;
    this.host.style.all = "initial";
    this.host.style.position = "fixed";
    this.host.style.inset = "0";
    this.host.style.zIndex = "2147483647";
    this.host.style.pointerEvents = "none";

    this.shadow = this.host.attachShadow({ mode: "closed" });
    this.shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .card {
          position: fixed;
          width: min(360px, calc(100vw - 24px));
          max-height: min(420px, calc(100vh - 24px));
          overflow: auto;
          box-sizing: border-box;
          padding: 12px;
          border: 1px solid rgba(0, 0, 0, .10);
          border-radius: 12px;
          background: rgba(255, 255, 255, .98);
          color: #171717;
          box-shadow: 0 12px 36px rgba(0, 0, 0, .18);
          font: 13px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          pointer-events: auto;
        }
        .header {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 8px;
        }
        .kind {
          padding: 2px 7px;
          border-radius: 999px;
          background: #f0f0f0;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: .04em;
        }
        .status {
          flex: 1;
          color: #777;
          font-size: 11px;
        }
        button {
          border: 0;
          border-radius: 7px;
          padding: 4px 7px;
          background: #f2f2f2;
          color: #333;
          font: inherit;
          cursor: pointer;
        }
        button:hover { background: #e7e7e7; }
        .selected {
          margin: 0 0 8px;
          font-weight: 650;
          overflow-wrap: anywhere;
        }
        .body {
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }
        .context {
          margin-top: 10px;
          padding-top: 8px;
          border-top: 1px solid #eee;
          color: #777;
          font-size: 11px;
        }
        .actions {
          display: flex;
          gap: 6px;
          margin-top: 10px;
        }
      </style>
      <div class="card" role="dialog" aria-label="Selection lookup result">
        <div class="header">
          <span class="kind"></span>
          <span class="status">Ready</span>
          <button class="close" type="button" aria-label="Close">×</button>
        </div>
        <div class="selected"></div>
        <div class="body"></div>
        <div class="context"></div>
        <div class="actions">
          <button class="regenerate" type="button">Regenerate</button>
          <button class="follow-up" type="button" disabled title="Available in the next phase">Follow up</button>
        </div>
      </div>
    `;

    this.card = this.shadow.querySelector(".card") as HTMLDivElement;
    this.body = this.shadow.querySelector(".body") as HTMLDivElement;
    this.status = this.shadow.querySelector(".status") as HTMLSpanElement;

    this.shadow.querySelector(".close")?.addEventListener("click", () => this.hide());
    this.shadow.querySelector(".regenerate")?.addEventListener("click", () => {
      const query = this.lastQuery;
      if (query) this.startFakeStream(query);
    });

    document.documentElement.appendChild(this.host);
  }

  private lastQuery: CardQuery | null = null;

  containsEvent(event: Event): boolean {
    return event.composedPath().includes(this.host);
  }

  show(query: CardQuery, anchor: AnchorPoint): void {
    this.lastQuery = query;
    this.anchor = anchor;
    this.host.style.display = "block";

    const kind = this.shadow.querySelector(".kind") as HTMLSpanElement;
    const selected = this.shadow.querySelector(".selected") as HTMLDivElement;
    const context = this.shadow.querySelector(".context") as HTMLDivElement;

    kind.textContent = query.selection.kind.toUpperCase();
    selected.textContent = query.selection.text;
    context.textContent = query.selection.kind === "word"
      ? `Context: ${query.context.currentSentence}`
      : `Context: ${[
          query.context.previousSentence,
          query.context.currentSentence,
          query.context.nextSentence
        ].filter(Boolean).join(" ")}`;

    this.position();
    requestAnimationFrame(() => this.position());
    this.startFakeStream(query);
  }

  hide(): void {
    this.cancelStream();
    this.host.style.display = "none";
  }

  cancelStream(): void {
    this.streamToken += 1;
    if (this.streamTimer !== null) {
      window.clearTimeout(this.streamTimer);
      this.streamTimer = null;
    }
  }

  reposition(): void {
    if (this.host.style.display !== "none") this.position();
  }

  private position(): void {
    if (!this.anchor) return;

    const margin = 10;
    const viewportPadding = 12;
    const cardRect = this.card.getBoundingClientRect();

    let left = this.anchor.left + this.anchor.width / 2 - cardRect.width / 2;
    left = Math.max(viewportPadding, Math.min(left, window.innerWidth - cardRect.width - viewportPadding));

    let top = this.anchor.bottom + margin;
    if (top + cardRect.height > window.innerHeight - viewportPadding) {
      top = Math.max(viewportPadding, this.anchor.top - cardRect.height - margin);
    }

    this.card.style.left = `${Math.round(left)}px`;
    this.card.style.top = `${Math.round(top)}px`;
  }

  private startFakeStream(query: CardQuery): void {
    this.cancelStream();
    const token = this.streamToken;
    this.body.textContent = "";
    this.status.textContent = "Mock streaming…";

    const output = query.selection.kind === "word"
      ? [
          "British IPA: /placeholder/\n",
          "Core meaning: mock definition for interaction testing.\n",
          `Context meaning: “${query.selection.text}” is interpreted using the surrounding sentence.\n`,
          "Part of speech: placeholder\n",
          "Roots / affixes: placeholder"
        ].join("")
      : "Mock contextual explanation: this sentence is interpreted together with the sentence before and after it. Real LLM output will replace this in Phase 2.";

    const chunks = output.match(/.{1,12}/gs) ?? [output];
    let index = 0;

    const push = () => {
      if (token !== this.streamToken) return;
      const chunk = chunks[index++];
      if (chunk === undefined) {
        this.status.textContent = "Mock complete";
        this.streamTimer = null;
        this.position();
        return;
      }

      this.body.textContent += chunk;
      this.position();
      this.streamTimer = window.setTimeout(push, 28);
    };

    push();
  }
}
