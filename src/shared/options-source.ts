export const OPTIONS_SOURCE_STORAGE_KEY = "selectionLookupOptionsSource";

export interface OptionsSourceTab {
  tabId: number;
  windowId: number;
  url: string;
  title: string;
  capturedAt: number;
}

export function isOptionsSourceTab(value: unknown): value is OptionsSourceTab {
  if (!value || typeof value !== "object") return false;
  const source = value as Partial<OptionsSourceTab>;
  return Number.isInteger(source.tabId)
    && Number.isInteger(source.windowId)
    && typeof source.url === "string"
    && typeof source.title === "string"
    && typeof source.capturedAt === "number"
    && Number.isFinite(source.capturedAt);
}
