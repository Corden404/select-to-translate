import type { SelectionKind } from "../shared/selection";
import type { ChatMessage } from "../shared/prompts";

export interface LookupHistoryRecord {
  id: string;
  createdAt: number;
  updatedAt: number;
  selectedText: string;
  queryType: SelectionKind;
  sourceType: "web" | "pdf";
  pageUrl: string;
  pageTitle: string;
  context: {
    previousSentence?: string;
    currentSentence: string;
    nextSentence?: string;
    quality?: "exact" | "fallback";
  };
  prompt: {
    id: string;
    version: number;
    name: string;
    snapshot: string;
  };
  provider: string;
  model: string;
  initialResponse: string;
  messages: ChatMessage[];
  status: "streaming" | "completed" | "aborted" | "error";
  errorMessage?: string;
}
