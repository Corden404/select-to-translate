import type { LookupRequestPayload } from "./messages";
import type { LookupSettings } from "./settings";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

function contextText(payload: LookupRequestPayload): string {
  if (payload.kind === "word") {
    return payload.context.currentSentence;
  }

  return [
    payload.context.previousSentence,
    payload.context.currentSentence,
    payload.context.nextSentence
  ].filter(Boolean).join("\n");
}

export function buildLookupMessages(
  settings: LookupSettings,
  payload: LookupRequestPayload
): ChatMessage[] {
  const systemPrompt = payload.kind === "word"
    ? settings.prompts.word
    : settings.prompts.sentence;

  const userContent = [
    "[UNTRUSTED READING CONTEXT]",
    contextText(payload),
    "",
    "[SELECTED TEXT]",
    payload.selectedText
  ].join("\n");

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent }
  ];
}
