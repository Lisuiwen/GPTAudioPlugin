import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = resolve(root, "dist");
if (dirname(output) !== root) throw new Error("Build output must stay inside the project.");
await rm(output, { recursive: true, force: true });
