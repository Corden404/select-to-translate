export interface AnchorPoint {
  left: number;
  top: number;
  bottom: number;
  width: number;
}

export function getSelectionAnchor(selection: Selection): AnchorPoint | null {
  if (selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();

  if (rect.width > 0 || rect.height > 0) {
    return {
      left: rect.left,
      top: rect.top,
      bottom: rect.bottom,
      width: rect.width
    };
  }

  const rects = Array.from(range.getClientRects());
  const fallback = rects.at(-1);
  if (!fallback) return null;

  return {
    left: fallback.left,
    top: fallback.top,
    bottom: fallback.bottom,
    width: fallback.width
  };
}
