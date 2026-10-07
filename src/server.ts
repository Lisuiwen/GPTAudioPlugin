import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve, join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { authenticateRequest, getPublicBaseUrl, handleAuthHttp, oauthChallenge } from "./auth.js";
import { createMusicServer, SERVER_VERSION } from "./music-server.js";
import { DEFAULT_ANALYSIS_MODEL, DEFAULT_MODEL, DEFAULT_PROVIDER_ID } from "./providers/index.js";
import { createLocalWorkflow } from "./node-workflow.js";

const MCP_PATH = "/mcp";
const OAUTH_SECURITY = [{ type: "oauth2" as const, scopes: ["replicate.read", "replicate.run"] }];
const local = createLocalWorkflow(resolve(process.env.MUSIC_DATA_DIR || join(process.env.AUTH_DATA_DIR || ".data", "music")));
const port = Number(process.env.PORT ?? 8787);
const baseUrl = getPublicBaseUrl(port);
function authRequired() {
  return { content: [{ type: "text" as const, text: "Connect Replicate to use listening/analysis." }], _meta: { "mcp/www_authenticate": [oauthChallenge(baseUrl)] }, isError: true };
}
const httpServer = createServer((req, res) => {
  handleRequest(req, res).catch(() => {
    console.error("Request failed. Check storage configuration and permissions.");
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "server_error" }));
  });
});
async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!req.url) { res.writeHead(400).end("Missing URL"); return; }
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (await handleAuthHttp(req, res, url, baseUrl)) return;
  if (req.method === "OPTIONS" && url.pathname === MCP_PATH) {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS", "Access-Control-Allow-Headers": "authorization, content-type, mcp-session-id, mcp-protocol-version", "Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate" }).end(); return;
  }
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ name: "GPTAudioMCP", status: "ok", version: SERVER_VERSION, buildSha: process.env.BUILD_SHA || "unknown", ui: false, mcp: MCP_PATH, providers: [DEFAULT_PROVIDER_ID], defaultProvider: DEFAULT_PROVIDER_ID, defaultModel: DEFAULT_MODEL, defaultAnalysisModel: DEFAULT_ANALYSIS_MODEL, oauth: { resourceMetadata: `${baseUrl}/.well-known/oauth-protected-resource`, authorizationServer: baseUrl } })); return;
  }
  if (url.pathname === MCP_PATH && ["POST", "GET", "DELETE"].includes(req.method || "")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");
    const session = authenticateRequest(req);
    if (req.headers.authorization && !session) {
      res.writeHead(401, { "WWW-Authenticate": oauthChallenge(baseUrl).replace('error="insufficient_scope"', 'error="invalid_token"'), "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_token", error_description: "Reconnect your listening account." })); return;
    }
    const server = createMusicServer(session, { securitySchemes: OAUTH_SECURITY, authRequired, workflow: local.workflow, runtime: "node", buildSha: process.env.BUILD_SHA, ownerId: session?.profileId, runwareApiKey: process.env.RUNWARE_API_KEY });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res); }
    catch { if (!res.headersSent) res.writeHead(500).end("Internal server error"); }
    return;
  }
  res.writeHead(404).end("Not Found");
}
httpServer.listen(port, "0.0.0.0", () => {
  const address = httpServer.address();
  const listeningPort = typeof address === "object" && address ? address.port : port;
  console.log(`GPTAudioMCP listening on 0.0.0.0:${listeningPort}${MCP_PATH}`);
  console.log("UI: disabled; use native ChatGPT attachments");
});
