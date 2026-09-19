import { test, expect, chromium } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const EDGE_PATH = process.env.EDGE_PATH
  ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

function createPdf(text: string): Buffer {
  const escaped = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const stream = text ? "BT /F1 20 Tf 72 700 Td (" + escaped + ") Tj ET" : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Length " + Buffer.byteLength(stream, "ascii") + " >>\nstream\n" + stream + "\nendstream"
  ];

  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(body, "ascii"));
    body += (index + 1) + " 0 obj\n" + objects[index] + "\nendobj\n";
  }

  const xrefOffset = Buffer.byteLength(body, "ascii");
  body += "xref\n0 6\n0000000000 65535 f \n";
  for (let index = 1; index <= 5; index++) {
    body += String(offsets[index]).padStart(10, "0") + " 00000 n \n";
  }
  body += "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" + xrefOffset + "\n%%EOF\n";
  return Buffer.from(body, "ascii");
}

test("extension lookup, streaming chat, history, settings, and PDF work end to end", async () => {
  const textPdf = createPdf("A PDF reader can detect words in context.");
  const blankPdf = createPdf("");

  const server = createServer((req, res) => {
    if (req.url === "/sample.pdf" || req.url === "/blank.pdf") {
      const data = req.url === "/sample.pdf" ? textPdf : blankPdf;
      res.writeHead(200, {
        "content-type": "application/pdf",
        "content-length": String(data.length)
      });
      res.end(data);
      return;
    }

    if (req.url === "/chat/completions" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", chunk => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        let body: {
          model?: string;
          messages?: Array<{ role?: string; content?: string }>;
        } = {};

        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          // The extension should always send valid JSON.
        }

        if (body.model === "mimo-v2.5-tts") {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({
            choices: [{
              message: {
                audio: {
                  data: "UklGRkZBS0VXQVY="
                }
              }
            }]
          }));
          return;
        }

        const followUp = Boolean(body.messages?.some(message =>
          message.role === "user" && message.content?.includes("为什么")
        ));
        const connectionTest = Boolean(body.messages?.some(message =>
          message.content?.includes("connection test")
        ));
        const parts = connectionTest
          ? ["OK"]
          : followUp
            ? ["追问", "回答"]
            : ["初始", "解释"];

        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache"
        });
        for (const part of parts) {
          res.write("data: " + JSON.stringify({
            choices: [{ delta: { content: part } }]
          }) + "\n\n");
        }
        res.end("data: [DONE]\n\n");
      });
      return;
    }

    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><html><body><p id='p'>A reliable lookup tool can detect the meaning of a word in context.</p></body></html>");
  });

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server failed");
  const origin = "http://127.0.0.1:" + address.port;

  const extensionPath = path.resolve("dist");
  const userDataDir = await mkdtemp(path.join(tmpdir(), "selection-lookup-e2e-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: EDGE_PATH,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions-except=" + extensionPath,
      "--load-extension=" + extensionPath
    ]
  });

  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;

    const popup = await context.newPage();
    await popup.goto("chrome-extension://" + extensionId + "/popup.html");
    await expect(popup.getByText("Prompt 管理")).toBeVisible();
    await expect(popup.getByText("发音设置")).toBeVisible();
    await expect(popup.locator("#pronunciationProvider")).toHaveValue("mimo");
    await expect(popup.locator("#mimoVoice")).toHaveValue("Mia");

    await popup.locator("#provider").selectOption("custom");
    await popup.locator("#apiKey").fill("test-key");
    await popup.locator("#baseUrl").fill(origin);
    await popup.locator("#model").fill("mock-model");
    await popup.locator("#testApi").click();
    await expect(popup.locator("#apiTestStatus")).toContainText("连接成功");
    await expect(popup.locator("#apiTestStatus")).toContainText("OK");

    await popup.locator("#mimoTtsKey").fill("test-key");
    await popup.locator("#mimoTtsBaseUrl").fill(origin);
    await popup.locator("#testPronunciation").click();
    await expect(popup.locator("#pronunciationTestStatus")).toContainText("连接成功");
    await popup.locator("#save").click();
    await expect(popup.locator("#status")).toHaveText("已保存。");

    const page = await context.newPage();
    await page.goto(origin + "/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(document.getElementById("__selection_lookup_root__")));

    const displayLatencyMs = await page.evaluate(async () => {
      const paragraph = document.getElementById("p")!;
      const node = paragraph.firstChild!;
      const text = node.textContent!;
      const start = text.indexOf("detect");
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + "detect".length);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);

      const host = document.getElementById("__selection_lookup_root__")!;
      const startedAt = performance.now();
      const visible = new Promise<number>(resolve => {
        const observer = new MutationObserver(() => {
          if (host.style.display === "block") {
            observer.disconnect();
            resolve(performance.now() - startedAt);
          }
        });
        observer.observe(host, { attributes: true, attributeFilter: ["style"] });
      });

      document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      return visible;
    });

    expect(displayLatencyMs).toBeLessThan(250);
    await expect(page.locator("#__selection_lookup_root__ .body")).toHaveText("初始解释");

    await page.locator("#__selection_lookup_root__ .follow-up").click();
    await page.locator("#__selection_lookup_root__ .chat-input").fill("为什么？");
    await page.locator("#__selection_lookup_root__ .send").click();
    await expect(page.locator("#__selection_lookup_root__ .bubble.assistant").last()).toHaveText("追问回答");

    const history = await context.newPage();
    await history.goto("chrome-extension://" + extensionId + "/history.html");
    await expect(history.getByText("detect", { exact: true })).toBeVisible();
    await history.getByText("detect", { exact: true }).click();
    await expect(history.getByText("初始解释", { exact: true })).toBeVisible();
    await expect(history.getByText("追问回答", { exact: true })).toBeVisible();

    const pdf = await context.newPage();
    await pdf.goto(
      "chrome-extension://" + extensionId + "/pdf.html?src=" + encodeURIComponent(origin + "/sample.pdf")
    );
    await expect(pdf.getByText(/已加载 1 页/)).toBeVisible();
    await pdf.waitForSelector(".pdf-text-layer span");

    await pdf.evaluate(() => {
      const span = [...document.querySelectorAll<HTMLElement>(".pdf-text-layer span")]
        .find(item => item.textContent?.includes("detect"));
      if (!span || !span.firstChild) throw new Error("PDF text layer did not contain detect");
      const node = span.firstChild;
      const text = node.textContent ?? "";
      const start = text.indexOf("detect");
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + "detect".length);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    });

    await expect(pdf.locator("#__selection_lookup_root__ .body")).toHaveText("初始解释");

    await pdf.goto(
      "chrome-extension://" + extensionId + "/pdf.html?src=" + encodeURIComponent(origin + "/blank.pdf")
    );
    await expect(pdf.getByText(/扫描型 PDF 暂不支持 OCR/)).toBeVisible();
  } finally {
    await context.close();
    server.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});
