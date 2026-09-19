import { describe, expect, it } from "vitest";
import {
  getMiMoExplanationSpeech,
  getMiMoPronunciation,
  streamMiMoExplanationSpeech
} from "../src/pronunciation/mimo";

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
      expect(result.diagnostics.inputChars).toBe("detect".length);
      expect(result.diagnostics.responseBytes).toBeGreaterThan(0);
      expect(result.diagnostics.audioBytes).toBe(11);
      expect(result.diagnostics.headersMs).toBeGreaterThanOrEqual(0);
      expect(result.diagnostics.bodyMs).toBeGreaterThanOrEqual(0);
      expect(result.diagnostics.parseMs).toBeGreaterThanOrEqual(0);
      expect(result.diagnostics.totalMs).toBeGreaterThanOrEqual(0);

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

  it("allows a longer teacher explanation and uses its own TTS style", async () => {
    const originalFetch = globalThis.fetch;
    let requestBody = "";
    globalThis.fetch = async (_input, init) => {
      requestBody = String(init?.body ?? "");
      return new Response(JSON.stringify({
        choices: [{ message: { audio: { data: "UklGRkZBS0VXQVY=" } } }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    try {
      const explanation = "Here, account for means to explain the reason for the decline. ".repeat(4);
      expect(explanation.length).toBeGreaterThan(160);
      const result = await getMiMoExplanationSpeech(explanation, {
        apiKey: "mimo-key",
        baseUrl: "https://api.xiaomimimo.com/v1",
        model: "mimo-v2.5-tts",
        voice: "Mia",
        style: "Speak like a natural teacher."
      });

      const body = JSON.parse(requestBody);
      expect(body.messages).toEqual([
        { role: "user", content: "Speak like a natural teacher." },
        { role: "assistant", content: explanation.trim() }
      ]);
      expect(result.label).toContain("自然讲解");
      expect(result.diagnostics.inputChars).toBe(explanation.trim().length);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("streams pcm16 audio chunks from MiMo SSE responses", async () => {
    const originalFetch = globalThis.fetch;
    let requestBody = "";
    const encoder = new TextEncoder();
    const firstAudio = "AAECAwQF";
    const secondAudio = "BgcICQoL";

    globalThis.fetch = async (_input, init) => {
      requestBody = String(init?.body ?? "");
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { audio: { data: firstAudio } } }] })}\n\n`));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { audio: { data: secondAudio } } }] })}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    };

    try {
      const received: string[] = [];
      const diagnostics = await streamMiMoExplanationSpeech(
        "Here, account for means to explain the reason.",
        {
          apiKey: "mimo-key",
          baseUrl: "https://api.xiaomimimo.com/v1",
          model: "mimo-v2.5-tts",
          voice: "Mia",
          style: "Speak naturally."
        },
        chunk => received.push(chunk)
      );

      const body = JSON.parse(requestBody);
      expect(body.stream).toBe(true);
      expect(body.audio).toEqual({ format: "pcm16", voice: "Mia" });
      expect(received).toEqual([firstAudio, secondAudio]);
      expect(diagnostics.chunkCount).toBe(2);
      expect(diagnostics.audioBytes).toBeGreaterThan(0);
      expect(diagnostics.responseBytes).toBeGreaterThan(0);
      expect(diagnostics.headersMs).toBeGreaterThanOrEqual(0);
      expect(diagnostics.firstAudioAfterHeadersMs).toBeGreaterThanOrEqual(0);
      expect(diagnostics.remainingStreamMs).toBeGreaterThanOrEqual(0);
      expect(diagnostics.totalMs).toBeGreaterThanOrEqual(0);
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
