#!/usr/bin/env node
// Copies the JS9 bundle out of node_modules into public/js9/ so Vite can serve
// it at runtime. Run automatically on postinstall; also safe to invoke manually.
//
// We don't ship the whole JS9 package under public/ (5 MB+ of demo imagery
// etc. not needed for display). Just the allinone bundle, the wasm blob for
// FITS decoding, and the UI icon set.

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const src = resolve(root, "node_modules/js9");
const dst = resolve(root, "public/js9");

if (!existsSync(src)) {
  console.error(`[copy-js9] ${src} not found — did npm install succeed?`);
  process.exit(0);
}

rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });

const files = ["js9-allinone.js", "js9-allinone.css", "astroemw.wasm"];
for (const f of files) {
  cpSync(resolve(src, f), resolve(dst, f));
}

// The UI icons in js9/images are referenced by the CSS. Skip the heavy demo
// imagery (voyager, js9logo, js9Readme, help/) that isn't needed for display.
const skip = new Set(["voyager", "voyager.icns", "js9logo", "js9Readme.png"]);
cpSync(resolve(src, "images"), resolve(dst, "images"), {
  recursive: true,
  filter: (srcPath) => {
    const base = srcPath.split("/").pop() ?? "";
    return !skip.has(base);
  },
});
cpSync(resolve(src, "font"), resolve(dst, "font"), { recursive: true });

console.log("[copy-js9] wrote", dst);
