import { describe, expect, it } from "vitest";
import { isRemotePdfUrl } from "../src/shared/options-source";

describe("isRemotePdfUrl", () => {
  it("matches plain http(s) pdf URLs", () => {
    expect(isRemotePdfUrl("https://example.com/paper.pdf")).toBe(true);
    expect(isRemotePdfUrl("https://example.com/paper.pdf?x=1")).toBe(true);
    expect(isRemotePdfUrl("https://example.com/paper.pdf#page=2")).toBe(true);
    expect(isRemotePdfUrl("http://127.0.0.1:8080/doc.pdf")).toBe(true);
  });

  it("rejects non-pdf paths, non-http schemes and empty strings", () => {
    expect(isRemotePdfUrl("https://example.com/paper.pdfx")).toBe(false);
    expect(isRemotePdfUrl("https://example.com/paperPDF")).toBe(false);
    expect(isRemotePdfUrl("ftp://example.com/paper.pdf")).toBe(false);
    expect(isRemotePdfUrl("")).toBe(false);
  });
});
