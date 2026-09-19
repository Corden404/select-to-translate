import type { LookupRequestPayload } from "./messages";
import type { LookupSettings, PromptDefinition } from "./settings";
import { resolvePrompt } from "./settings";

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

export function renderUserTemplate(prompt: PromptDefinition, payload: LookupRequestPayload): string {
  return prompt.userTemplate
    .replaceAll("{{context}}", contextText(payload))
    .replaceAll("{{selection}}", payload.selectedText)
    .replaceAll("{{pageTitle}}", payload.pageTitle)
    .replaceAll("{{pageUrl}}", payload.pageUrl);
}

export function buildLookupMessages(
  settings: LookupSettings,
  payload: LookupRequestPayload,
  promptId?: string
): { prompt: PromptDefinition; messages: ChatMessage[] } {
  const prompt = resolvePrompt(settings, payload.kind, promptId);
  return {
    prompt,
    messages: [
      { role: "system", content: prompt.systemPrompt },
      { role: "user", content: renderUserTemplate(prompt, payload) }
    ]
  };
}
