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
  console.log(JSON.stringify({ endpoint: endpoint.href, server, tools: names }, null, 2));
  assert.equal(server?.version, manifest.version, "MCP version differs from plugin version");
  assert.deepEqual(names, ["analyze_music", "generate_music", "get_music_provider_profile", "inspect_music_model", "get_service_status", "register_music_audio", "get_music_audio", "delete_music_audio", "get_music_job", "cancel_music_job", "compare_music"].sort());
  const result = await client.callTool({ name: "get_music_provider_profile", arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result._meta?.["mcp/www_authenticate"]?.[0] || "", /resource_metadata=/);
  console.log("MCP version, all workflow tools, and OAuth challenge verified. No billable tools were called.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "MCP verification failed");
  process.exitCode = 1;
} finally {
  await client.close();
}
