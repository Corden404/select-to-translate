import type { SelectionKind } from "./selection";

export interface LookupContextPayload {
  previousSentence?: string;
  currentSentence: string;
  nextSentence?: string;
  quality?: "exact" | "fallback";
}

export interface LookupRequestPayload {
  selectedText: string;
  kind: SelectionKind;
  context: LookupContextPayload;
  pageUrl: string;
  pageTitle: string;
  sourceType?: "web" | "pdf";
}

export type LookupPortRequest =
  | {
      type: "LOOKUP_START";
      requestId: string;
      promptId?: string;
      payload: LookupRequestPayload;
    }
  | {
      type: "CHAT_SEND";
      requestId: string;
      message: string;
    };

export type LookupPortResponse =
  | { type: "LOOKUP_STARTED"; requestId: string; recordId: string; promptId: string; promptName: string }
  | { type: "LOOKUP_CHUNK"; requestId: string; text: string }
  | { type: "LOOKUP_DONE"; requestId: string }
  | { type: "CHAT_STARTED"; requestId: string }
  | { type: "CHAT_CHUNK"; requestId: string; text: string }
  | { type: "CHAT_DONE"; requestId: string }
  | { type: "LOOKUP_ERROR"; requestId: string; message: string };

export type OneShotMessage =
  | { type: "PRONUNCIATION_GET"; word: string };

export interface PronunciationResponse {
  ok: boolean;
  provider?: "mimo" | "youdao";
  phonetic?: string;
  audioDataUrl?: string;
  label?: string;
  message?: string;
}
