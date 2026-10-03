import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { authenticateRequest, getPublicBaseUrl, handleAuthHttp, oauthChallenge } from "./auth.js";
import { createMusicServer, SERVER_VERSION } from "./music-server.js";
import { DEFAULT_ANALYSIS_MODEL, DEFAULT_MODEL, DEFAULT_PROVIDER_ID } from "./providers/index.js";

const MCP_PATH = "/mcp";
const OAUTH_SECURITY = [{ type: "oauth2" as const, scopes: ["replicate.read", "replicate.run"] }];

function authRequired(baseUrl: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: "Connect your Replicate account to continue.",
      },
    ],
    _meta: {
      "mcp/www_authenticate": [oauthChallenge(baseUrl)],
    },
    isError: true,
  };
}

const port = Number(process.env.PORT ?? 8787);
const baseUrl = getPublicBaseUrl(port);

const httpServer = createServer((req, res) => {
  handleRequest(req, res).catch(() => {
    console.error("Request failed. Check OAuth storage configuration and permissions.");
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "server_error" }));
    } else {
      res.end();
    }
  });
});

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!req.url) {
    res.writeHead(400).end("Missing URL");
    return;
  }

  const requestUrl = new URL(
    req.url,
    `http://${req.headers.host ?? "localhost"}`
  );

  if (await handleAuthHttp(req, res, requestUrl, baseUrl)) {
    return;
  }

  if (req.method === "OPTIONS" && requestUrl.pathname === MCP_PATH) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
      "Access-Control-Allow-Headers":
        "authorization, content-type, mcp-session-id, mcp-protocol-version",
      "Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/") {
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(
        JSON.stringify({
          name: "GPTAudioMCP",
          status: "ok",
          version: SERVER_VERSION,
          ui: false,
          mcp: MCP_PATH,
          providers: [DEFAULT_PROVIDER_ID],
          defaultProvider: DEFAULT_PROVIDER_ID,
          defaultModel: DEFAULT_MODEL,
          defaultAnalysisModel: DEFAULT_ANALYSIS_MODEL,
          oauth: {
            resourceMetadata: `${baseUrl}/.well-known/oauth-protected-resource`,
            authorizationServer: baseUrl,
          },
        })
      );
    return;
  }

  const allowedMethods = new Set(["POST", "GET", "DELETE"]);
  if (
    requestUrl.pathname === MCP_PATH &&
    req.method &&
    allowedMethods.has(req.method)
  ) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");

    const authSession = authenticateRequest(req);
    if (req.headers.authorization && !authSession) {
      res.writeHead(401, {
        "WWW-Authenticate": oauthChallenge(baseUrl).replace(
          'error="insufficient_scope"',
          'error="invalid_token"'
        ),
        "content-type": "application/json",
      });
      res.end(JSON.stringify({ error: "invalid_token", error_description: "Reconnect your Replicate account." }));
      return;
    }
    const server = createMusicServer(authSession, { securitySchemes: OAUTH_SECURITY, authRequired: () => authRequired(baseUrl) });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("MCP request failed:", error);
      if (!res.headersSent) {
        res.writeHead(500).end("Internal server error");
      }
    }
    return;
  }

  res.writeHead(404).end("Not Found");
}

httpServer.listen(port, "0.0.0.0", () => {
  const address = httpServer.address();
  const listeningPort = typeof address === "object" && address ? address.port : port;
  console.log(
    `GPTAudioMCP listening on 0.0.0.0:${listeningPort}${MCP_PATH}`
  );
  console.log("UI: disabled; use native ChatGPT attachments");
  console.log(`Provider: ${DEFAULT_PROVIDER_ID}`);
  console.log(`OAuth issuer: ${baseUrl}`);
});
