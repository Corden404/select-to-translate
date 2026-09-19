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
  const replacements: Record<string, string> = {
    context: contextText(payload),
    selection: payload.selectedText,
    pageTitle: payload.pageTitle,
    pageUrl: payload.pageUrl
  };
  return prompt.userTemplate.replace(
    /\{\{(context|selection|pageTitle|pageUrl)\}\}/g,
    (match, key: string) => replacements[key] ?? match
  );
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

export function buildSpeechExplanationMessages(
  settings: LookupSettings,
  payload: LookupRequestPayload
): ChatMessage[] {
  return [
    {
      role: "system",
      content: settings.speechExplanation.prompt
        + "\n\nMandatory output rule: Respond entirely in English. Do not use Chinese or any other language."
    },
    {
      role: "user",
      content: `[UNTRUSTED READING CONTEXT]\n${contextText(payload)}\n\n[SELECTED TEXT]\n${payload.selectedText}`
    }
  ];
}
