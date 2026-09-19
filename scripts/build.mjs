import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

await Promise.all([
  build({
    entryPoints: ["src/content/main.ts"],
    outfile: "dist/content.js",
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["chrome120", "edge120"],
    sourcemap: true,
    logLevel: "info"
  }),
  build({
    entryPoints: ["src/background/service-worker.ts"],
    outfile: "dist/background.js",
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["chrome120", "edge120"],
    sourcemap: true,
    logLevel: "info"
  }),
  build({
    entryPoints: ["src/popup/main.ts"],
    outfile: "dist/popup.js",
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["chrome120", "edge120"],
    sourcemap: true,
    logLevel: "info"
  })
]);

await Promise.all([
  cp("public/manifest.json", "dist/manifest.json"),
  cp("public/popup.html", "dist/popup.html")
]);

console.log("Built extension into dist/");
