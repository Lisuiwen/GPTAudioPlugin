// Local development MCP server; production requests are authenticated by Sites.
import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMusicServer, SERVER_VERSION } from "./music-server.js";
import { DEFAULT_MODEL } from "./providers/index.js";
import { RUNWARE_LISTENING_MODEL } from "./providers/runware-listening.js";
import { createLocalWorkflow } from "./node-workflow.js";

const MCP_PATH = "/mcp";
const local = createLocalWorkflow(resolve(process.env.MUSIC_DATA_DIR || ".data/music"));
const port = Number(process.env.PORT ?? 8787);

// Only local clients can reach this no-auth development endpoint.
const httpServer = createServer((req, res) => {
  handleRequest(req, res).catch(() => {
    console.error("Local MCP request failed. Check storage and Runware configuration.");
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "server_error" }));
  });
});

// Route health and MCP requests while retaining the local workflow identity.
async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!req.url) {
    res.writeHead(400).end("Missing URL");
    return;
  }
  const url = new URL(req.url, "http://127.0.0.1:" + port);
  if (req.method === "OPTIONS" && url.pathname === MCP_PATH) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "http://127.0.0.1:" + port,
      "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, mcp-session-id, mcp-protocol-version",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
    }).end();
    return;
  }
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      name: "GPTAudioMCP",
      status: "ok",
      version: SERVER_VERSION,
      buildSha: process.env.BUILD_SHA || "unknown",
      mcp: MCP_PATH,
      providers: { generation: "runware", listening: "runware" },
      defaultModel: DEFAULT_MODEL,
      listeningModel: RUNWARE_LISTENING_MODEL,
      runwareConfigured: !!process.env.RUNWARE_API_KEY?.trim(),
    }));
    return;
  }
  if (url.pathname === MCP_PATH && ["POST", "GET", "DELETE"].includes(req.method || "")) {
    const server = createMusicServer({
      workflow: local.workflow,
      runtime: "node",
      buildSha: process.env.BUILD_SHA,
      ownerId: "local-dev",
      runwareApiKey: process.env.RUNWARE_API_KEY,
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500).end("Internal server error");
    }
    return;
  }
  res.writeHead(404).end("Not Found");
}

httpServer.listen(port, "127.0.0.1", () => {
  console.log("GPTAudioMCP local server listening on 127.0.0.1:" + port + MCP_PATH);
});
