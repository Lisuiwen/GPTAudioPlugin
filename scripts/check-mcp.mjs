// Read-only catalog check for the local Runware generation and listening endpoint.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const manifest = JSON.parse(await readFile(new URL("../plugin.json", import.meta.url), "utf8"));
const endpoint = new URL(process.argv[2] || process.env.MCP_URL || "http://127.0.0.1:8787/mcp");
const client = new Client({ name: "gpt-audio-diagnostics", version: manifest.version });

try {
  await client.connect(new StreamableHTTPClientTransport(endpoint));
  const server = client.getServerVersion();
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  const expected = [
    "analyze_music",
    "cancel_music_job",
    "compare_music",
    "delete_music_audio",
    "generate_music",
    "get_music_audio",
    "get_music_job",
    "get_service_status",
    "inspect_music_model",
    "register_music_audio",
  ];
  assert.equal(server?.version, manifest.version, "MCP version differs from plugin version");
  assert.deepEqual(names, expected);
  const generate = tools.find((tool) => tool.name === "generate_music");
  assert.equal(generate?.inputSchema?.properties?.duration?.maximum, 300);
  assert.deepEqual(generate?.inputSchema?.properties?.generationMode?.enum, ["auto", "generate", "cover", "reference", "repaint", "continue"]);
  assert.equal("provider" in (generate?.inputSchema?.properties || {}), false);
  const response = await client.callTool({ name: "get_service_status", arguments: {} });
  const status = response.structuredContent;
  assert.equal(status?.version, manifest.version);
  assert.equal(status?.providers?.generation, "runware");
  assert.equal(status?.providers?.listening, "runware");
  assert.equal(status?.tools?.length, expected.length);
  console.log(JSON.stringify({ endpoint: endpoint.href, version: status.version, tools: names, runwareConfigured: status.runwareConfigured }, null, 2));
  console.log("Only discovery and status were called; no billable inference was created.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "MCP verification failed");
  process.exitCode = 1;
} finally {
  await client.close();
}
