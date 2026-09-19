import type { SelectionKind } from "../shared/selection";

export interface ExtractedContext {
  previousSentence?: string;
  currentSentence: string;
  nextSentence?: string;
  quality: "exact" | "fallback";
}

const BLOCK_SELECTOR = [
  "P",
  "LI",
  "BLOCKQUOTE",
  "TD",
  "TH",
  "DD",
  "DT",
  "PRE",
  "FIGCAPTION"
].join(",");

interface SentenceSpan {
  text: string;
  start: number;
  end: number;
}

function nearestTextContainer(node: Node): Element | null {
  const element = node.nodeType === Node.ELEMENT_NODE
    ? (node as Element)
    : node.parentElement;

  return element?.closest(BLOCK_SELECTOR) ?? element;
}

function segmentSentences(text: string): SentenceSpan[] {
  if (!text.trim()) return [];

  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
    return Array.from(segmenter.segment(text), item => ({
      text: item.segment.trim(),
      start: item.index,
      end: item.index + item.segment.length
    })).filter(item => item.text.length > 0);
  }

  const spans: SentenceSpan[] = [];
  const matcher = /[^.!?]+[.!?]+|[^.!?]+$/g;
  for (const match of text.matchAll(matcher)) {
    if (match.index === undefined) continue;
    const raw = match[0];
    const leading = raw.search(/\S/);
    if (leading < 0) continue;
    spans.push({
      text: raw.trim(),
      start: match.index + leading,
      end: match.index + raw.length
    });
  }
  return spans;
}

function findSentenceIndex(spans: SentenceSpan[], offset: number): number {
  const containing = spans.findIndex(span => offset >= span.start && offset < span.end);
  if (containing >= 0) return containing;

  const following = spans.findIndex(span => span.start >= offset);
  return following >= 0 ? following : Math.max(0, spans.length - 1);
}

export function extractContext(
  selection: Selection,
  kind: SelectionKind,
  selectedText: string
): ExtractedContext {
  if (selection.rangeCount === 0) {
    return { currentSentence: selectedText, quality: "fallback" };
  }

  const range = selection.getRangeAt(0);
  const container = nearestTextContainer(range.commonAncestorContainer);
  if (!container || !container.contains(range.commonAncestorContainer)) {
    return { currentSentence: selectedText, quality: "fallback" };
  }

  try {
    const beforeRange = document.createRange();
    beforeRange.selectNodeContents(container);
    beforeRange.setEnd(range.startContainer, range.startOffset);

    const afterRange = document.createRange();
    afterRange.selectNodeContents(container);
    afterRange.setStart(range.endContainer, range.endOffset);

    const before = beforeRange.toString();
    const selected = range.toString();
    const after = afterRange.toString();
    const fullText = before + selected + after;
    const spans = segmentSentences(fullText);

    if (spans.length === 0) {
      return { currentSentence: selectedText, quality: "fallback" };
    }

    const selectionMidpoint = before.length + Math.max(0, selected.length / 2);
    const index = findSentenceIndex(spans, selectionMidpoint);
    const current = spans[index]?.text || selectedText;

    if (kind === "word") {
      return { currentSentence: current, quality: "exact" };
    }

    return {
      previousSentence: spans[index - 1]?.text,
      currentSentence: current,
      nextSentence: spans[index + 1]?.text,
      quality: "exact"
    };
  } catch {
    return { currentSentence: selectedText, quality: "fallback" };
  }
}
