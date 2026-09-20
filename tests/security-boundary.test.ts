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

  it("rejects synthetic page triggers and hides card internals from page scripts", () => {
    const contentSource = readFileSync(new URL("../src/content/main.ts", import.meta.url), "utf8");
    const cardSource = readFileSync(new URL("../src/content/floating-card.ts", import.meta.url), "utf8");
    expect(contentSource).toContain("!event.isTrusted");
    expect(cardSource).toContain('attachShadow({ mode: "closed" })');
    expect(cardSource).toContain("!event.isTrusted");
    expect(contentSource).toContain("eventTargetsEditable");
    expect(contentSource).toContain("MANUAL_LOOKUP_TRIGGER");
  });

  it("ships explicit manual lookup entry points", () => {
    const manifest = JSON.parse(readFileSync(new URL("../public/manifest.json", import.meta.url), "utf8"));
    expect(manifest.permissions).toContain("contextMenus");
    expect(manifest.commands["lookup-selection"]).toBeTruthy();
    const workerSource = readFileSync(new URL("../src/background/service-worker.ts", import.meta.url), "utf8");
    expect(workerSource).toContain("MANUAL_LOOKUP_MENU_ID");
    expect(workerSource).toContain("sendManualLookup");
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
