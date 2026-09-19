import { build } from "esbuild";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";

await mkdir("dist/extension", { recursive: true });
for (const entry of ["extension/background.ts", "extension/content.ts", "extension/popup.ts"]) {
  const name = entry.split("/")[1].replace(".ts", ".js");
  const options = { entryPoints: [entry], bundle: true, outfile: `dist/extension/${name}`, format: "iife", target: "chrome120", external: ["node:*"] };
  if (name === "popup.js") {
    options.banner = { js: "async function main() {" };
    options.footer = { js: "} main().catch(console.error);" };
  }
  await build(options);
}
const manifest = JSON.parse(await readFile("extension/manifest.json", "utf8"));
manifest.key = JSON.parse(await readFile("extension/key.json", "utf8")).key;
await writeFile("dist/extension/manifest.json", JSON.stringify(manifest, null, 2));
await cp("extension/popup.html", "dist/extension/popup.html");
await cp("extension/assets", "dist/extension/assets", { recursive: true });
console.log("Built dist/extension");
