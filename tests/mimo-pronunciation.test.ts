import { describe, expect, it } from "vitest";
import { getMiMoPronunciation } from "../src/pronunciation/mimo";

describe("MiMo TTS pronunciation provider", () => {
  it("calls MiMo chat completions with assistant-role text and returns WAV audio", async () => {
    const originalFetch = globalThis.fetch;
    let requestBody = "";
    let requestHeaders: HeadersInit | undefined;

    globalThis.fetch = async (_input, init) => {
      requestBody = String(init?.body ?? "");
      requestHeaders = init?.headers;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            audio: {
              data: "UklGRkZBS0VXQVY="
            }
          }
        }]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    try {
      const result = await getMiMoPronunciation("detect", {
        apiKey: "mimo-key",
        baseUrl: "https://api.xiaomimimo.com/v1",
        model: "mimo-v2.5-tts",
        voice: "Mia",
        style: "Use a clear British English accent."
      });

      expect(result.audioDataUrl).toBe("data:audio/wav;base64,UklGRkZBS0VXQVY=");
      expect(result.label).toContain("Mia");

      const body = JSON.parse(requestBody);
      expect(body.model).toBe("mimo-v2.5-tts");
      expect(body.audio).toEqual({ format: "wav", voice: "Mia" });
      expect(body.messages).toEqual([
        { role: "user", content: "Use a clear British English accent." },
        { role: "assistant", content: "detect" }
      ]);

      const headers = new Headers(requestHeaders);
      expect(headers.get("api-key")).toBe("mimo-key");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("requires a MiMo API key", async () => {
    await expect(getMiMoPronunciation("detect", {
      apiKey: "",
      baseUrl: "https://api.xiaomimimo.com/v1",
      model: "mimo-v2.5-tts",
      voice: "Mia",
      style: ""
    })).rejects.toThrow("API Key");
  });
});
