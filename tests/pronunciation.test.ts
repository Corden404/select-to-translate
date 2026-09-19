import { describe, expect, it } from "vitest";
import { getYoudaoPronunciation } from "../src/pronunciation/youdao";

describe("Youdao pronunciation provider", () => {
  it("signs the official dictionary request and parses UK pronunciation", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; body?: string }> = [];

    globalThis.fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, body: init?.body ? String(init.body) : undefined });

      if (url === "https://openapi.youdao.com/v2/dict") {
        return new Response(JSON.stringify({
          errorCode: "0",
          basic: {
            ukPhonetic: "dɪˈtekt",
            ukSpeech: "https://audio.example/detect.mp3"
          }
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "audio/mpeg" }
      });
    };

    try {
      const result = await getYoudaoPronunciation("detect", {
        enabled: true,
        appKey: "app-key",
        appSecret: "secret"
      });

      expect(result.phonetic).toBe("dɪˈtekt");
      expect(result.audioDataUrl).toBeUndefined();
      expect(result.label).toContain("英式音标");
      expect(requests[0].url).toBe("https://openapi.youdao.com/v2/dict");

      const form = new URLSearchParams(requests[0].body);
      expect(form.get("q")).toBe("detect");
      expect(form.get("appKey")).toBe("app-key");
      expect(form.get("signType")).toBe("v3");
      expect(form.get("sign")).toMatch(/^[a-f0-9]{64}$/);
      expect(requests).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("requires explicit Youdao configuration", async () => {
    await expect(getYoudaoPronunciation("detect", {
      enabled: false,
      appKey: "",
      appSecret: ""
    })).rejects.toThrow("尚未启用");
  });
});
