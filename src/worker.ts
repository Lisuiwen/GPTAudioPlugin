// Sites Worker entry point for the owner-scoped Runware generation and listening service.
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMusicServer, SERVER_VERSION } from "./music-server.js";
import { MusicWorkflow } from "./music-workflow.js";
import { AudioAssets, WorkflowStore, type AudioBucket, type SitesDatabase } from "./workflow-store.js";

declare const __BUILD_SHA__: string;
type Environment = { DB: SitesDatabase; AUDIO_BUCKET?: AudioBucket; BUILD_SHA?: string; RUNWARE_API_KEY?: string };

class RequestInputError extends Error {}

// Report the exact deployed build without exposing environment secrets.
function buildSha(env: Environment): string {
  return env.BUILD_SHA || (typeof __BUILD_SHA__ !== "undefined" ? __BUILD_SHA__ : "unknown");
}

// Keep JSON responses uncached because deployment configuration can change.
function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

// Construct the persistent workflow against the existing D1 and optional audio bucket.
function services(env: Environment): MusicWorkflow {
  const store = new WorkflowStore(env.DB);
  return new MusicWorkflow(store, new AudioAssets(store, env.AUDIO_BUCKET), env.RUNWARE_API_KEY);
}

// The old connection URL now shows a read-only service page with no credential form.
function homePage(configured: boolean): Response {
  const state = configured ? "Runware 已配置，音乐生成、编辑与听音评价可用。" : "Runware 尚未配置，请在 Site 环境设置中添加 RUNWARE_API_KEY。";
  const html = [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>GPT Audio</title>',
    '<style>body{font:16px/1.65 system-ui,sans-serif;background:#0c1220;color:#e7edf9;margin:0;padding:32px 20px}',
    'main{max-width:560px;margin:8vh auto}h1{font-size:28px;color:#a1c1ff}</style></head>',
    '<body><main><h1>GPT Audio ', SERVER_VERSION, '</h1><p>', state, '</p>',
    '<p>在 ChatGPT 中使用 GPT Audio MCP 生成、编辑或评价音乐。本站无需填写个人服务令牌。</p>',
    '</main></body></html>',
  ].join("");
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// Bound request reads prevent oversized form or MCP payloads from reaching the service.
async function readBody(request: Request, limit: number): Promise<string> {
  if (Number(request.headers.get("content-length")) > limit) throw new RequestInputError("请求内容过大。");
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return body + decoder.decode();
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new RequestInputError("请求内容过大。");
      }
      body += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

// Sites authenticates requests before forwarding trusted user identity headers.
async function handle(request: Request, env: Environment): Promise<Response> {
  const url = new URL(request.url);
  const userId = request.headers.get("oai-authenticated-user-id")?.trim();
  if (request.method === "GET" && url.pathname === "/health") {
    return json({ name: "GPTAudioMCP", status: "ok", version: SERVER_VERSION, buildSha: buildSha(env), mcp: "/mcp" });
  }
  if (request.method === "GET" && url.pathname.startsWith("/audio/")) {
    if (!userId) return json({ error: "unauthorized" }, 401);
    try {
      const file = await services(env).assets.file(userId, decodeURIComponent(url.pathname.slice(7)));
      return new Response(file, {
        headers: {
          "Content-Type": file.type,
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Disposition": 'inline; filename="' + file.name.replace(/[^a-zA-Z0-9._-]/g, "_") + '"',
        },
      });
    } catch {
      return json({ error: "audio_unavailable" }, 404);
    }
  }
  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/connect")) {
    if (!userId) return json({ error: "unauthorized", message: "请先通过 Sites 登录。" }, 401);
    return homePage(!!env.RUNWARE_API_KEY?.trim());
  }
  if ((url.pathname === "/connect" || url.pathname === "/disconnect") && request.method === "POST") {
    return json({ error: "gone", message: "个人令牌配置入口已移除。" }, 410);
  }
  if (url.pathname === "/mcp" && request.method === "POST") {
    if (!request.headers.get("content-type")?.startsWith("application/json")) return json({ error: "unsupported_media_type" }, 415);
    const body = await readBody(request, 4 * 1024 * 1024);
    let rpc: { method?: string };
    try {
      rpc = JSON.parse(body);
    } catch {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
    }
    if (!rpc || typeof rpc !== "object" || Array.isArray(rpc)) {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }, 400);
    }
    if (rpc.method === "tools/call" && !userId) return json({ error: "unauthorized" }, 401);
    const server = createMusicServer({
      workflow: services(env),
      runtime: "sites",
      buildSha: buildSha(env),
      ownerId: userId || undefined,
      runwareApiKey: env.RUNWARE_API_KEY,
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      return await transport.handleRequest(request, { parsedBody: rpc });
    } finally {
      await server.close();
    }
  }
  if (url.pathname === "/mcp") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  return json({ error: "not_found" }, 404);
}

// Return stable service errors while keeping provider and secret details in server logs.
export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    try {
      return await handle(request, env);
    } catch (error) {
      if (error instanceof RequestInputError) return json({ error: "invalid_request", message: error.message }, 400);
      console.error("GPTAudioMCP request failed; check storage and Runware availability.");
      return json({ error: "service_unavailable", message: "服务暂时不可用，请稍后重试。" }, 503);
    }
  },
};
