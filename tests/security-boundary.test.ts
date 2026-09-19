import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, toPublicLookupSettings } from "../src/shared/settings";

describe("content-script secret boundary", () => {
  it("keeps direct local storage access out of the content script", () => {
    const source = readFileSync(new URL("../src/content/main.ts", import.meta.url), "utf8");
    expect(source).not.toContain("chrome.storage");
    expect(source).not.toContain("loadLookupSettings");
    expect(source).not.toContain("SETTINGS_STORAGE_KEY");
  });

  it("hardens storage access in the service worker", () => {
    const source = readFileSync(new URL("../src/background/service-worker.ts", import.meta.url), "utf8");
    expect(source).toContain('setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })');
  });

  it("public settings structurally omit privileged configuration", () => {
    const publicSettings = toPublicLookupSettings({
      ...DEFAULT_SETTINGS,
      api: {
        ...DEFAULT_SETTINGS.api,
        apiKey: "main-secret"
      },
      pronunciation: {
        ...DEFAULT_SETTINGS.pronunciation,
        mimo: {
          ...DEFAULT_SETTINGS.pronunciation.mimo,
          apiKey: "tts-secret"
        },
        youdao: {
          enabled: true,
          appKey: "youdao-key",
          appSecret: "youdao-secret"
        }
      }
    });
    const serialized = JSON.stringify(publicSettings);

    expect(serialized).not.toContain("main-secret");
    expect(serialized).not.toContain("tts-secret");
    expect(serialized).not.toContain("youdao-key");
    expect(serialized).not.toContain("youdao-secret");
    expect(serialized).not.toContain("systemPrompt");
    expect(serialized).not.toContain("userTemplate");
  });
});
