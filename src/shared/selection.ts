export type SelectionKind = "word" | "sentence";

export interface ClassifiedSelection {
  text: string;
  kind: SelectionKind;
  wordCount: number;
}

const WORD_PATTERN = /[A-Za-z]+(?:['’\-][A-Za-z]+)*/g;
const LETTER_PATTERN = /[A-Za-z]/g;

export function countEnglishWords(text: string): number {
  return text.match(WORD_PATTERN)?.length ?? 0;
}

export function normalizeSelectionText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function isEnglishSelection(text: string): boolean {
  const normalized = normalizeSelectionText(text);
  if (!normalized) return false;

  const words = countEnglishWords(normalized);
  if (words === 0) return false;

  const letters = normalized.match(LETTER_PATTERN)?.length ?? 0;
  const visible = normalized.replace(/\s/g, "").length;
  return visible > 0 && letters / visible >= 0.6;
}

export function classifySelection(rawText: string): ClassifiedSelection | null {
  const text = normalizeSelectionText(rawText);
  if (!isEnglishSelection(text)) return null;

  const wordCount = countEnglishWords(text);
  if (wordCount === 0 || wordCount > 30) return null;

  const hasSentencePunctuation = /[.!?](?:["'’”)]*)?$/.test(text);
  const looksLikePhrase = wordCount <= 4 && !hasSentencePunctuation;

  return {
    text,
    kind: wordCount === 1 || looksLikePhrase ? "word" : "sentence",
    wordCount
  };
}
