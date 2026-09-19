export type SelectionKind = "word" | "sentence";

export interface ClassifiedSelection {
  text: string;
  kind: SelectionKind;
  wordCount: number;
}

const WORD_PATTERN = /[A-Za-z]+(?:['’\-][A-Za-z]+)*/g;
const LETTER_PATTERN = /[A-Za-z]/g;
const PERSONAL_SUBJECTS = new Set(["i", "you", "he", "she", "it", "we", "they"]);
const FINITE_OR_AUXILIARY = new Set([
  "am", "is", "are", "was", "were", "have", "has", "had", "do", "does", "did",
  "can", "could", "will", "would", "shall", "should", "may", "might", "must",
  "love", "like", "want", "need", "know", "think", "see", "feel", "mean", "agree",
  "believe", "understand", "work", "works", "matter", "matters", "seem", "seems"
]);
const NON_VERB_AFTER_SUBJECT = new Set([
  "a", "an", "the", "my", "your", "his", "her", "our", "their",
  "this", "that", "these", "those", "very", "really", "quite", "too", "so",
  "and", "or", "but", "of", "in", "on", "at", "for", "with", "to", "from"
]);

function looksLikeShortClause(text: string, wordCount: number): boolean {
  if (wordCount < 2 || wordCount > 4) return false;
  const words = text.match(WORD_PATTERN)?.map(word => word.toLowerCase()) ?? [];
  if (words.length !== wordCount) return false;

  const [first, second, third] = words;
  if (PERSONAL_SUBJECTS.has(first)) {
    if (FINITE_OR_AUXILIARY.has(second)) return true;
    return wordCount >= 3 && !NON_VERB_AFTER_SUBJECT.has(second);
  }

  if ((first === "this" || first === "that") && FINITE_OR_AUXILIARY.has(second)) return true;
  if ((first === "the" || first === "a" || first === "an") && wordCount >= 3 && third) {
    return FINITE_OR_AUXILIARY.has(third) || /(?:s|ed)$/.test(third);
  }

  return false;
}

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
  const shortClause = !hasSentencePunctuation && looksLikeShortClause(text, wordCount);
  const looksLikePhrase = wordCount <= 4 && !hasSentencePunctuation && !shortClause;

  return {
    text,
    kind: wordCount === 1 || looksLikePhrase ? "word" : "sentence",
    wordCount
  };
}
