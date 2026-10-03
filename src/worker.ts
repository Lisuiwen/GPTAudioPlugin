import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMusicServer, SERVER_VERSION } from "./music-server.js";
import { MusicWorkflow } from "./music-workflow.js";
import { AudioAssets, WorkflowStore, type AudioBucket } from "./workflow-store.js";
import { ConnectionInputError, connectReplicate, disconnectReplicate, readConnection, readSession, type SitesEnvironment } from "./sites-store.js";

declare const __BUILD_SHA__: string;
type Environment = SitesEnvironment & { AUDIO_BUCKET?: AudioBucket; BUILD_SHA?: string };
const buildSha = (env: Environment) => env.BUILD_SHA || (typeof __BUILD_SHA__ !== "undefined" ? __BUILD_SHA__ : "unknown");
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const services = (env: Environment) => { const store = new WorkflowStore(env.DB); return new MusicWorkflow(store, new AudioAssets(store, env.AUDIO_BUCKET)); };

function connectionPage(username?: string): Response {
  const status = username ? `已连接 Replicate 账号：${escapeHtml(username)}` : "连接 Replicate 后，即可在对话中生成音乐或分析音频。";
  return new Response(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>GPT Audio · 账号连接</title>
<style>body{font:16px/1.65 system-ui,sans-serif;background:#0c1220;color:#e7edf9;margin:0;padding:32px 20px}main{max-width:560px;margin:8vh auto}h1{font-size:28px}a{color:#8eb8ff}label{display:block;margin:24px 0 8px}input{box-sizing:border-box;width:100%;padding:12px;background:#172239;color:inherit;border:1px solid #7182a0;border-radius:6px;font:inherit}button{padding:11px 18px;background:#a1c1ff;color:#111d34;border:0;border-radius:6px;font:inherit;cursor:pointer;margin-top:16px}button:disabled{opacity:.6}#message{min-height:26px;color:#ffb8b8}.secondary{background:#24324c;color:#e7edf9}</style></head>
<body><main><h1>GPT Audio</h1><p>${status}</p><p>在 <a href="https://replicate.com/account/api-tokens" target="_blank" rel="noopener noreferrer">Replicate API 令牌页面</a>获取令牌。只在此页面输入，请勿发送到对话中。</p>
<form action="/connect" method="post"><label for="token">Replicate API 令牌</label><input id="token" name="replicate_token" type="password" required maxlength="4096" autocomplete="off"><button type="submit">${username ? "更新连接" : "连接 Replicate"}</button></form>
${username ? '<button id="disconnect" class="secondary">断开 Replicate 连接</button>' : ""}<p id="message" role="status" aria-live="polite"></p><p>完成连接后，回到 GPT 桌面端的插件中调用音乐工具。</p></main>
<script>async function submit(path,body){const buttons=document.querySelectorAll('button');buttons.forEach(b=>b.disabled=true);document.getElementById('message').textContent='正在处理…';try{const response=await fetch(path,{method:'POST',body,credentials:'same-origin'});const result=await response.json();if(!response.ok)throw new Error(result.message||'操作失败，请稍后重试。');location.reload()}catch(error){document.getElementById('message').textContent=error.message;buttons.forEach(b=>b.disabled=false)}}document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();submit('/connect',new URLSearchParams(new FormData(event.target)))});document.getElementById('disconnect')?.addEventListener('click',()=>submit('/disconnect',new URLSearchParams()));</script></body></html>`, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" },
  });
}
async function readBody(request: Request, limit: number): Promise<string> {
  if (Number(request.headers.get("content-length")) > limit) throw new ConnectionInputError("请求内容过大。");
  if (!request.body) return "";
  const reader = request.body.getReader(), decoder = new TextDecoder();
  let body = "", size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return body + decoder.decode();
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new ConnectionInputError("请求内容过大。"); }
      body += decoder.decode(value, { stream: true });
    }
  } finally { reader.releaseLock(); }
}
async function handle(request: Request, env: Environment): Promise<Response> {
  const url = new URL(request.url);
  // Only the authenticated Sites gateway may reach this Worker. Do not expose
  // this identity-header trust model directly on the public internet.
  const userId = request.headers.get("oai-authenticated-user-id")?.trim();
  if (request.method === "GET" && url.pathname === "/health") return json({ name: "GPTAudioMCP", status: "ok", version: SERVER_VERSION, buildSha: buildSha(env), mcp: "/mcp" });
  if (request.method === "GET" && url.pathname.startsWith("/audio/")) {
    if (!userId) return json({ error: "unauthorized" }, 401);
    try {
      const file = await services(env).assets.file(userId, decodeURIComponent(url.pathname.slice(7)));
      return new Response(file, { headers: { "Content-Type": file.type, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": `inline; filename="${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}"` } });
    } catch { return json({ error: "audio_unavailable" }, 404); }
  }
  if (request.method === "GET" && ["/", "/connect"].includes(url.pathname)) {
    if (!userId) return json({ error: "unauthorized", message: "请先通过 Sites 登录。" }, 401);
    return connectionPage((await readConnection(env, userId))?.username);
  }
  if (request.method === "POST" && ["/connect", "/disconnect"].includes(url.pathname)) {
    if (!userId) return json({ error: "unauthorized" }, 401);
    if (request.headers.get("origin") !== url.origin) return json({ error: "forbidden" }, 403);
    if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) return json({ error: "unsupported_media_type" }, 415);
    const body = await readBody(request, 8192);
    if (url.pathname === "/disconnect") await disconnectReplicate(env, userId);
    else await connectReplicate(env, userId, new URLSearchParams(body).get("replicate_token")?.trim() || "");
    return json({ status: "ok" });
  }
  if (url.pathname === "/mcp" && request.method === "POST") {
    if (!request.headers.get("content-type")?.startsWith("application/json")) return json({ error: "unsupported_media_type" }, 415);
    const body = await readBody(request, 4 * 1024 * 1024);
    let rpc: { method?: string };
    try { rpc = JSON.parse(body); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }
    if (!rpc || typeof rpc !== "object" || Array.isArray(rpc)) return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }, 400);
    const isToolCall = rpc.method === "tools/call";
    if (isToolCall && !userId) return json({ error: "unauthorized" }, 401);
    const session = isToolCall ? await readSession(env, userId!) : undefined;
    const server = createMusicServer(session, {
      securitySchemes: [{ type: "noauth" }],
      authRequired: () => ({ content: [{ type: "text", text: `Connect your Replicate account at ${url.origin}/connect, then retry this tool.` }], isError: true }),
      workflow: services(env), runtime: "sites", buildSha: buildSha(env),
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try { await server.connect(transport); return await transport.handleRequest(request, { parsedBody: rpc }); }
    finally { await server.close(); }
  }
  if (url.pathname === "/mcp") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  return json({ error: "not_found" }, 404);
}
export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    try { return await handle(request, env); }
    catch (error) {
      if (error instanceof ConnectionInputError) return json({ error: "invalid_request", message: error.message }, 400);
      console.error("GPTAudioMCP request failed; check storage, encryption key, and provider availability.");
      return json({ error: "service_unavailable", message: "连接服务暂时不可用，请保留输入并稍后重试。" }, 503);
    }
  },
};
