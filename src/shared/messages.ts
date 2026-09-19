import type { SelectionKind } from "./selection";

export interface LookupContextPayload {
  previousSentence?: string;
  currentSentence: string;
  nextSentence?: string;
}

export interface LookupRequestPayload {
  selectedText: string;
  kind: SelectionKind;
  context: LookupContextPayload;
  pageUrl: string;
  pageTitle: string;
}

export type LookupPortRequest = {
  type: "LOOKUP_START";
  requestId: string;
  payload: LookupRequestPayload;
};

export type LookupPortResponse =
  | { type: "LOOKUP_STARTED"; requestId: string }
  | { type: "LOOKUP_CHUNK"; requestId: string; text: string }
  | { type: "LOOKUP_DONE"; requestId: string }
  | { type: "LOOKUP_ERROR"; requestId: string; message: string };
