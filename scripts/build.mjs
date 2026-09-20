import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

const browserTarget = ["chrome120", "edge120"];

await Promise.all([
  build({
    entryPoints: ["src/content/main.ts"],
    outfile: "dist/content.js",
    bundle: true,
    format: "iife",
    platform: "browser",
    target: browserTarget,
    sourcemap: true,
    logLevel: "info"
  }),
  build({
    entryPoints: ["src/background/service-worker.ts"],
    outfile: "dist/background.js",
    bundle: true,
    format: "esm",
    platform: "browser",
    target: browserTarget,
    sourcemap: true,
    logLevel: "info"
  }),
  build({
    entryPoints: ["src/options/main.ts"],
    outfile: "dist/options.js",
    bundle: true,
    format: "esm",
    platform: "browser",
    target: browserTarget,
    sourcemap: true,
    logLevel: "info"
  }),
  build({
    entryPoints: ["src/offscreen/main.ts"],
    outfile: "dist/offscreen.js",
    bundle: true,
    format: "esm",
    platform: "browser",
    target: browserTarget,
    sourcemap: true,
    logLevel: "info"
  }),
  build({
    entryPoints: ["src/history-page/main.ts"],
    outfile: "dist/history.js",
    bundle: true,
    format: "esm",
    platform: "browser",
    target: browserTarget,
    sourcemap: true,
    logLevel: "info"
  }),
  build({
    entryPoints: ["src/pdf/main.ts"],
    outfile: "dist/pdf.js",
    bundle: true,
    format: "esm",
    platform: "browser",
    target: browserTarget,
    sourcemap: true,
    logLevel: "info"
  })
]);

await Promise.all([
  cp("public/icons", "dist/icons", { recursive: true }),
  cp("public/manifest.json", "dist/manifest.json"),
  cp("public/options.html", "dist/options.html"),
  cp("public/offscreen.html", "dist/offscreen.html"),
  cp("public/history.html", "dist/history.html"),
  cp("public/pdf.html", "dist/pdf.html"),
  cp("node_modules/pdfjs-dist/build/pdf.worker.mjs", "dist/pdf.worker.mjs")
]);

console.log("Built extension into dist/");
