import "dotenv/config";

import { createServer } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import {
  authenticateRequest,
  getPublicBaseUrl,
  handleAuthHttp,
  oauthChallenge,
  type AuthSession,
} from "./auth.js";
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_ID,
  getMusicProvider,
} from "./providers/index.js";

const MCP_PATH = "/mcp";
const OAUTH_SCOPES = ["replicate.read", "replicate.run"];
const OAUTH_SECURITY = [{ type: "oauth2" as const, scopes: OAUTH_SCOPES }];

const OpenAIFileSchema = z.object({
  download_url: z.string().url(),
  file_id: z.string().min(1),
  mime_type: z.string().optional(),
  file_name: z.string().optional(),
});

const providerSchema = z
  .literal("replicate")
  .default(DEFAULT_PROVIDER_ID)
  .describe(
    "Music provider. Replicate is the only provider enabled in v0.4."
  );

const capabilitiesOutputSchema = {
  provider: z.string(),
  model: z.string(),
  supportsTextPrompt: z.boolean(),
  promptField: z.string().optional(),
  supportsAudioInput: z.boolean(),
  audioField: z.string().optional(),
  durationField: z.string().optional(),
  continuationField: z.string().optional(),
  outputFormatField: z.string().optional(),
  inputFields: z.array(z.string()),
  requiredFields: z.array(z.string()),
  unsupportedRequiredFields: z.array(z.string()),
};

const generateInputSchema = {
  provider: providerSchema,
  model: z
    .string()
    .optional()
    .describe(
      'Provider model identifier. For Replicate use "owner/name" or "owner/name:version". Omit to use the default model.'
    ),
  conversationSummary: z
    .string()
    .min(1)
    .describe(
      "Concise relevant context from the current ChatGPT conversation. Compose this in ChatGPT; do not call a separate text-model API."
    ),
  directorPrompt: z
    .string()
    .min(1)
    .describe(
      "Production-ready music direction composed by ChatGPT from the current conversation and user request."
    ),
  duration: z.number().int().min(1).max(30).default(8),
  referenceAudio: OpenAIFileSchema.optional().describe(
    "The user's audio attachment from the normal ChatGPT conversation. Pass it directly when the selected model supports reference audio."
  ),
  continuation: z
    .boolean()
    .default(false)
    .describe(
      "When supported by the selected model, extend/continue the attached reference audio."
    ),
};

const generationOutputSchema = {
  status: z.string(),
  provider: z.string(),
  audioUrl: z.string().optional(),
  model: z.string(),
  prompt: z.string().optional(),
  referenceAudioUsed: z.boolean().optional(),
  audioInputField: z.string().optional(),
  error: z.string().optional(),
};

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

function createMusicServer(
  authSession: AuthSession | undefined,
  baseUrl: string
): McpServer {
  const server = new McpServer(
    {
      name: "gpt-audio-mcp",
      version: "0.4.0",
    },
    {
      instructions:
        "This is a UI-less music generation MCP for ChatGPT. Reuse the current ChatGPT conversation as the reasoning layer. If the user attached an audio file in ChatGPT, pass that native attachment directly to generate_music.referenceAudio. Compose conversationSummary and directorPrompt from the current chat. Do not ask the user to upload the same file again and do not call a separate text-model API. Replicate is the only enabled provider in v0.4; provider plumbing is isolated so more providers can be added later.",
    }
  );

  server.registerTool(
    "get_music_provider_profile",
    {
      title: "Music provider profile",
      description:
        "Return the currently connected music-provider identity. v0.4 uses Replicate.",
      inputSchema: {
        provider: providerSchema,
      },
      outputSchema: {
        provider: z.string(),
        id: z.string(),
        name: z.string().optional(),
        nickname: z.string().optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: {
        securitySchemes: OAUTH_SECURITY,
        "openai/profile": true,
      },
    },
    async (args) => {
      if (!authSession) return authRequired(baseUrl);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              provider: args.provider,
              id: authSession.profileId,
              name: authSession.name || authSession.username,
              nickname: `${authSession.username} — Replicate`,
            }),
          },
        ],
        structuredContent: {
          provider: args.provider,
          id: authSession.profileId,
          name: authSession.name || authSession.username,
          nickname: `${authSession.username} — Replicate`,
        },
      };
    }
  );

  server.registerTool(
    "inspect_music_model",
    {
      title: "Inspect music model",
      description:
        "Inspect the selected provider model before generation. Use this when the user picks a non-default model or when you need to verify that an attached audio file is supported.",
      inputSchema: {
        provider: providerSchema,
        model: z.string().default(DEFAULT_MODEL),
      },
      outputSchema: capabilitiesOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      _meta: {
        securitySchemes: OAUTH_SECURITY,
        "openai/toolInvocation/invoking": "Checking music model…",
        "openai/toolInvocation/invoked": "Music model capabilities loaded.",
      },
    },
    async (args) => {
      if (!authSession) return authRequired(baseUrl);

      try {
        const provider = getMusicProvider(args.provider);
        const capabilities = await provider.inspectModel(
          authSession.replicateToken,
          args.model || provider.defaultModel
        );

        return {
          content: [
            {
              type: "text",
              text: capabilities.supportsAudioInput
                ? `${capabilities.provider}/${capabilities.model} supports reference audio via ${capabilities.audioField}.`
                : `${capabilities.provider}/${capabilities.model} does not expose a recognizable audio input.`,
            },
          ],
          structuredContent: capabilities,
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to inspect model.";

        return {
          content: [{ type: "text", text: message }],
          structuredContent: {
            provider: args.provider,
            model: args.model || DEFAULT_MODEL,
            supportsTextPrompt: false,
            supportsAudioInput: false,
            inputFields: [],
            requiredFields: [],
            unsupportedRequiredFields: [],
          },
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "generate_music",
    {
      title: "Generate music",
      description:
        "Generate music from the current ChatGPT conversation and optional native ChatGPT audio attachment. The MCP automatically inspects the selected provider model, maps compatible inputs, and rejects reference audio when the model cannot consume it.",
      inputSchema: generateInputSchema,
      outputSchema: generationOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
      _meta: {
        securitySchemes: OAUTH_SECURITY,
        "openai/fileParams": ["referenceAudio"],
        "openai/toolInvocation/invoking": "Generating music…",
        "openai/toolInvocation/invoked": "Music generation finished.",
      },
    },
    async (args) => {
      if (!authSession) return authRequired(baseUrl);

      try {
        const provider = getMusicProvider(args.provider);
        const result = await provider.generate(authSession.replicateToken, {
          model: args.model,
          conversationSummary: args.conversationSummary,
          directorPrompt: args.directorPrompt,
          duration: args.duration ?? 8,
          referenceAudioUrl: args.referenceAudio?.download_url,
          referenceAudioName: args.referenceAudio?.file_name,
          referenceAudioMimeType: args.referenceAudio?.mime_type,
          continuation: args.continuation ?? false,
        });

        const referenceAudioUsed = Boolean(args.referenceAudio);

        return {
          content: [
            {
              type: "text",
              text: referenceAudioUsed
                ? `Generated music with ${result.provider} using the attached audio: ${result.audioUrl}`
                : `Generated music with ${result.provider}: ${result.audioUrl}`,
            },
          ],
          structuredContent: {
            status: "succeeded",
            provider: result.provider,
            audioUrl: result.audioUrl,
            model: result.model,
            prompt: result.prompt,
            referenceAudioUsed,
            audioInputField: result.capabilities.audioField,
          },
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown generation error.";

        return {
          content: [
            {
              type: "text",
              text: `Music generation failed: ${message}`,
            },
          ],
          structuredContent: {
            status: "failed",
            provider: args.provider,
            model: args.model || DEFAULT_MODEL,
            referenceAudioUsed: false,
            error: message,
          },
          isError: true,
        };
      }
    }
  );

  return server;
}

const port = Number(process.env.PORT ?? 8787);
const baseUrl = getPublicBaseUrl(port);

const httpServer = createServer(async (req, res) => {
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
        "authorization, content-type, mcp-session-id",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
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
          version: "0.4.0",
          ui: false,
          mcp: MCP_PATH,
          providers: [DEFAULT_PROVIDER_ID],
          defaultProvider: DEFAULT_PROVIDER_ID,
          defaultModel: DEFAULT_MODEL,
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
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

    const authSession = authenticateRequest(req);
    const server = createMusicServer(authSession, baseUrl);
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
});

httpServer.listen(port, "127.0.0.1", () => {
  console.log(
    `GPTAudioMCP listening on http://127.0.0.1:${port}${MCP_PATH}`
  );
  console.log("UI: disabled; use native ChatGPT attachments");
  console.log(`Provider: ${DEFAULT_PROVIDER_ID}`);
  console.log(`OAuth issuer: ${baseUrl}`);
});
