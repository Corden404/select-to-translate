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

test("extension security, lookup, history, settings, and PDF work end to end", async () => {
  const textPdf = createPdf("A PDF reader can detect words in context.");
  const blankPdf = createPdf("");
  let initialLookupRequests = 0;
  let followUpRequests = 0;

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
          message.role === "user"
          && (message.content?.includes("为什么") || message.content?.includes("keyboard test"))
        ));
        const connectionTest = Boolean(body.messages?.some(message =>
          message.content?.includes("connection test")
        ));
        const partialFailure = Boolean(body.messages?.some(message =>
          message.content?.includes("[SELECTED TEXT]\npartialfail")
        ));
        if (partialFailure) {
          initialLookupRequests += 1;
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache"
          });
          res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "部分回答" } }] }) + "\n\n");
          res.end("data: " + JSON.stringify({ error: { message: "forced partial failure" } }) + "\n\n");
          return;
        }
        if (followUp) {
          followUpRequests += 1;
        } else if (!connectionTest) {
          initialLookupRequests += 1;
        }
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
    res.end("<!doctype html><html><body><p id='p'>A reliable lookup tool can <span id='word'>detect</span> the meaning of a word in context. Another test uses <span id='partial'>partialfail</span>.</p><div id='editor' contenteditable='true'>editable</div><button id='other'>Elsewhere</button><div style='height:2000px'></div></body></html>");
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
    await popup.goto("chrome-extension://" + extensionId + "/options.html");
    await expect(popup.getByText("Prompt 管理")).toBeVisible();
    await expect(popup.getByText("发音设置")).toBeVisible();
    await expect(popup.locator("#pronunciationProvider")).toHaveValue("mimo");
    await expect(popup.locator("#mimoVoice")).toHaveValue("Mia");
    await expect(popup.locator("#stopAudioOnCardClose")).toBeVisible();
    await expect(popup.locator("#stopAudioOnCardClose")).toBeChecked();

    await popup.locator("#provider").selectOption("custom");
    await popup.locator("#apiKey").fill("test-key");
    await popup.locator("#baseUrl").fill(origin);
    await popup.locator("#model").fill("mock-model");
    await popup.locator("#provider").selectOption("deepseek");
    await popup.locator("#provider").selectOption("custom");
    await expect(popup.locator("#apiKey")).toHaveValue("test-key");
    await expect(popup.locator("#baseUrl")).toHaveValue(origin);
    await expect(popup.locator("#model")).toHaveValue("mock-model");
    await expect(popup.locator("#historyEnabled")).toBeChecked();
    await expect(popup.locator("#historyRetentionDays")).toHaveValue("90");
    await popup.locator("#testApi").click();
    await expect(popup.locator("#apiTestStatus")).toContainText("连接成功");
    await expect(popup.locator("#apiTestStatus")).toContainText("OK");

    await popup.locator("#mimoTtsKey").fill("test-key");
    await popup.locator("#mimoTtsBaseUrl").fill(origin);
    await popup.locator("#testPronunciation").click();
    await expect(popup.locator("#pronunciationTestStatus")).toContainText("连接成功");
    await popup.locator("#save").click();
    await expect(popup.locator("#status")).toHaveText("已保存。");

    const invalidLookupResponse = await popup.evaluate(() => new Promise<unknown>(resolve => {
      const port = chrome.runtime.connect({ name: "lookup-stream" });
      const timeout = window.setTimeout(() => {
        port.disconnect();
        resolve(null);
      }, 1500);
      port.onMessage.addListener(message => {
        window.clearTimeout(timeout);
        port.disconnect();
        resolve(message);
      });
      port.postMessage({
        type: "LOOKUP_START",
        requestId: "invalid-e2e-request",
        payload: {
          selectedText: "detect",
          kind: "word",
          context: { currentSentence: "This tool can detect words in context." },
          pageUrl: "https://example.com",
          pageTitle: "x".repeat(1001),
          sourceType: "web"
        }
      });
    }));
    expect(invalidLookupResponse).toMatchObject({
      type: "LOOKUP_ERROR",
      requestId: "invalid-e2e-request"
    });

    const page = await context.newPage();
    await page.goto(origin + "/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(document.getElementById("__selection_lookup_root__")));

    await page.evaluate(() => {
      const word = document.getElementById("word")!;
      const node = word.firstChild!;
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    });
    await page.waitForTimeout(180);
    expect(initialLookupRequests).toBe(0);
    expect(await page.evaluate(() => document.getElementById("__selection_lookup_root__")!.style.display)).toBe("none");
    expect(await page.evaluate(() => document.getElementById("__selection_lookup_root__")!.shadowRoot)).toBeNull();

    await page.evaluate(() => {
      const other = document.getElementById("other")!;
      other.addEventListener("pointerdown", event => {
        event.preventDefault();
        const word = document.getElementById("word")!;
        const range = document.createRange();
        range.selectNodeContents(word);
        const selection = getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
      }, { once: true });
    });
    await page.locator("#other").click();
    await page.waitForTimeout(180);
    expect(initialLookupRequests).toBe(0);

    await page.locator("#editor").dblclick();
    await page.waitForTimeout(180);
    expect(initialLookupRequests).toBe(0);

    const displayStartedAt = Date.now();
    await page.locator("#word").dblclick();
    await expect.poll(() => page.evaluate(() => getSelection()?.toString().trim())).toBe("detect");
    await page.waitForFunction(
      () => document.getElementById("__selection_lookup_root__")?.style.display === "block",
      undefined,
      { timeout: 3000 }
    );
    expect(Date.now() - displayStartedAt).toBeLessThan(500);
    await expect.poll(() => initialLookupRequests).toBe(1);
    expect(await page.evaluate(() => document.getElementById("__selection_lookup_root__")!.shadowRoot)).toBeNull();

    const cdp = await context.newCDPSession(page);
    await cdp.send("DOM.enable");
    type CdpNode = {
      nodeId: number;
      attributes?: string[];
      children?: CdpNode[];
      shadowRoots?: CdpNode[];
    };
    const findNodeByClass = (node: CdpNode, className: string): number | null => {
      const attributes = node.attributes ?? [];
      for (let index = 0; index + 1 < attributes.length; index += 2) {
        if (attributes[index] === "class"
          && attributes[index + 1].split(/\s+/).includes(className)) {
          return node.nodeId;
        }
      }
      for (const child of [...(node.shadowRoots ?? []), ...(node.children ?? [])]) {
        const found = findNodeByClass(child, className);
        if (found !== null) return found;
      }
      return null;
    };
    const getClosedShadowNodeId = async (className: string): Promise<number> => {
      const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
      const nodeId = findNodeByClass(root as unknown as CdpNode, className);
      if (nodeId === null) throw new Error("Closed-shadow node not found: " + className);
      return nodeId;
    };
    const clickClosedShadowNode = async (className: string): Promise<void> => {
      const nodeId = await getClosedShadowNodeId(className);
      const { model } = await cdp.send("DOM.getBoxModel", { nodeId });
      const quad = model.border;
      const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
      const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
      await page.mouse.click(x, y);
    };
    const getClosedShadowBox = async (className: string) => {
      const nodeId = await getClosedShadowNodeId(className);
      const { model } = await cdp.send("DOM.getBoxModel", { nodeId });
      const quad = model.border;
      const xs = [quad[0], quad[2], quad[4], quad[6]];
      const ys = [quad[1], quad[3], quad[5], quad[7]];
      const left = Math.min(...xs);
      const right = Math.max(...xs);
      const top = Math.min(...ys);
      const bottom = Math.max(...ys);
      return { left, right, top, bottom, width: right - left, height: bottom - top };
    };

    const cardBeforeDrag = await getClosedShadowBox("card");
    const statusBeforeDrag = await getClosedShadowBox("status");
    const dragStartX = statusBeforeDrag.left + statusBeforeDrag.width / 2;
    const dragStartY = statusBeforeDrag.top + statusBeforeDrag.height / 2;
    await page.mouse.move(dragStartX, dragStartY);
    await page.mouse.down();
    await page.mouse.move(dragStartX + 90, dragStartY + 60, { steps: 5 });
    await page.mouse.up();
    const cardAfterDrag = await getClosedShadowBox("card");
    expect(cardAfterDrag.left - cardBeforeDrag.left).toBeGreaterThan(50);
    expect(cardAfterDrag.top - cardBeforeDrag.top).toBeGreaterThan(30);

    const statusAfterDrag = await getClosedShadowBox("status");
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await page.mouse.move(
      statusAfterDrag.left + statusAfterDrag.width / 2,
      statusAfterDrag.top + statusAfterDrag.height / 2
    );
    await page.mouse.down();
    await page.mouse.move(viewport.width + 1000, viewport.height + 1000, { steps: 5 });
    await page.mouse.up();
    const boundedCard = await getClosedShadowBox("card");
    expect(boundedCard.right).toBeLessThanOrEqual(viewport.width - 10);
    expect(boundedCard.bottom).toBeLessThanOrEqual(viewport.height - 10);

    await expect.poll(async () => {
      const nodeId = await getClosedShadowNodeId("follow-up");
      const { attributes } = await cdp.send("DOM.getAttributes", { nodeId });
      return attributes.includes("disabled");
    }).toBe(false);
    await page.evaluate(() => {
      const counters = { bubble: 0, captureEditableAware: 0 };
      (window as typeof window & { __lookupShortcutCounters?: typeof counters }).__lookupShortcutCounters = counters;
      document.addEventListener("keydown", () => {
        counters.bubble += 1;
      });
      document.addEventListener("keydown", event => {
        const target = event.target;
        if (target instanceof HTMLElement
          && (target.isContentEditable || target.matches("input, textarea, select"))) {
          return;
        }
        counters.captureEditableAware += 1;
      }, true);
    });
    await clickClosedShadowNode("follow-up");
    await expect.poll(() => page.evaluate(() =>
      document.getElementById("__selection_lookup_root__")?.dataset.lookupTextEntry
    )).toBe("true");

    const chatInputNodeId = await getClosedShadowNodeId("chat-input");
    const resolvedChatInput = await cdp.send("DOM.resolveNode", { nodeId: chatInputNodeId });
    const chatInputObjectId = resolvedChatInput.object.objectId;
    if (!chatInputObjectId) throw new Error("Unable to resolve chat input");
    const chatInputValue = async (): Promise<string> => {
      const result = await cdp.send("Runtime.callFunctionOn", {
        objectId: chatInputObjectId,
        functionDeclaration: "function(){ return this.value; }",
        returnByValue: true
      });
      return String(result.result.value ?? "");
    };

    await page.keyboard.type("keyboard test");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("more");
    expect(await chatInputValue()).toBe("keyboard test\nmore");
    expect(await page.evaluate(() =>
      (window as typeof window & {
        __lookupShortcutCounters?: { bubble: number; captureEditableAware: number };
      }).__lookupShortcutCounters
    )).toEqual({ bubble: 0, captureEditableAware: 0 });
    await page.keyboard.press("Enter");
    await expect.poll(() => followUpRequests).toBe(1);
    expect(await page.evaluate(() =>
      (window as typeof window & {
        __lookupShortcutCounters?: { bubble: number; captureEditableAware: number };
      }).__lookupShortcutCounters
    )).toEqual({ bubble: 0, captureEditableAware: 0 });

    await page.evaluate(() => window.scrollTo(0, 600));
    await expect.poll(() => page.evaluate(() => document.getElementById("__selection_lookup_root__")!.style.display)).toBe("none");
    await page.evaluate(() => window.scrollTo(0, 0));

    const setBehavior = async (mode: "auto" | "manual", paused: boolean) => {
      await worker.evaluate(async ({ host, mode, paused }) => {
        const stored = await chrome.storage.local.get("lookupSettings");
        const settings = stored.lookupSettings as {
          behavior: { mode: "auto" | "manual"; disabledHosts: string[] };
        };
        settings.behavior.mode = mode;
        settings.behavior.disabledHosts = paused ? [host] : [];
        await chrome.storage.local.set({ lookupSettings: settings });
      }, { host: "127.0.0.1", mode, paused });
      await page.waitForTimeout(120);
    };
    const triggerManual = async () => {
      await worker.evaluate(async targetUrl => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find(item => item.url === targetUrl);
        if (typeof tab?.id !== "number") throw new Error("test page tab not found");
        await chrome.tabs.sendMessage(tab.id, { type: "MANUAL_LOOKUP_TRIGGER" });
      }, origin + "/");
    };

    await setBehavior("auto", true);
    await page.locator("#word").dblclick();
    await page.waitForTimeout(180);
    expect(initialLookupRequests).toBe(1);
    await triggerManual();
    await expect.poll(() => initialLookupRequests).toBe(2);

    await setBehavior("manual", false);
    await page.locator("#word").dblclick();
    await page.waitForTimeout(180);
    expect(initialLookupRequests).toBe(2);
    await triggerManual();
    await expect.poll(() => initialLookupRequests).toBe(3);
    await page.evaluate(() => window.scrollTo(0, 600));
    await expect.poll(() => page.evaluate(() => document.getElementById("__selection_lookup_root__")!.style.display)).toBe("none");
    await page.evaluate(() => window.scrollTo(0, 0));

    await setBehavior("auto", false);
    await page.locator("#partial").dblclick();
    await expect.poll(() => initialLookupRequests).toBe(4);
    await page.waitForTimeout(180);

    const history = await context.newPage();
    await history.goto("chrome-extension://" + extensionId + "/history.html");
    await expect(history.getByText("detect", { exact: true }).first()).toBeVisible();
    await history.locator("#search").fill("partialfail");
    await expect(history.getByText("partialfail", { exact: true }).first()).toBeVisible();
    await history.getByText("partialfail", { exact: true }).first().click();
    await expect(history.getByText("部分回答", { exact: true }).first()).toBeVisible();
    await expect(history.getByText(/forced partial failure/)).toBeVisible();

    const pdf = await context.newPage();
    await pdf.goto(
      "chrome-extension://" + extensionId + "/pdf.html?src=" + encodeURIComponent(origin + "/sample.pdf")
    );
    await expect(pdf.getByText(/已加载 1 页/)).toBeVisible();
    await pdf.waitForSelector(".pdf-text-layer span");

    const pdfText = pdf.locator(".pdf-text-layer span").filter({ hasText: "detect" }).first();
    const pdfTextBox = await pdfText.boundingBox();
    const pdfTextValue = await pdfText.textContent();
    if (!pdfTextBox || !pdfTextValue) throw new Error("PDF text layer did not contain a selectable span");
    const detectIndex = pdfTextValue.indexOf("detect");
    if (detectIndex < 0) throw new Error("PDF text layer did not contain detect");
    const detectCenter = (detectIndex + "detect".length / 2) / pdfTextValue.length;
    await pdf.mouse.dblclick(
      pdfTextBox.x + Math.max(1, Math.min(pdfTextBox.width - 1, pdfTextBox.width * detectCenter)),
      pdfTextBox.y + pdfTextBox.height / 2
    );
    await expect.poll(() => pdf.evaluate(() => getSelection()?.toString().trim())).toBe("detect");
    await pdf.waitForFunction(
      () => document.getElementById("__selection_lookup_root__")?.style.display === "block",
      undefined,
      { timeout: 3000 }
    );
    await expect.poll(() => initialLookupRequests).toBe(5);
    expect(await pdf.evaluate(() => document.getElementById("__selection_lookup_root__")!.shadowRoot)).toBeNull();

    await pdf.goto(
      "chrome-extension://" + extensionId + "/pdf.html?src=" + encodeURIComponent(origin + "/blank.pdf")
    );
    await expect(pdf.getByText(/抽样页面未检测到可选择文本/)).toBeVisible();
  } finally {
    await context.close();
    server.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});
