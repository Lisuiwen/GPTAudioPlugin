import { build } from "esbuild";
import { copyFile, mkdir, readFile } from "node:fs/promises";

await mkdir("dist/server", { recursive: true });
await mkdir("dist/.openai", { recursive: true });
await build({
  entryPoints: ["src/worker.ts"],
  outfile: "dist/server/index.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  inject: ["src/worker-globals.ts"],
  minify: true,
  // The Worker supplies Web APIs and uses no Node HTTP or filesystem modules.
  conditions: ["worker", "browser"],
});
await copyFile(".openai/hosting.json", "dist/.openai/hosting.json");
const source = await readFile("dist/server/index.js", "utf8");
const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
if (typeof module.default?.fetch !== "function") throw new Error("Site artifact must export default.fetch");
console.log(`Built Sites MCP Worker (${Buffer.byteLength(source)} bytes).`);
