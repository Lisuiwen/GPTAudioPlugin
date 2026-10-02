import "dotenv/config";

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

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
  DEFAULT_ANALYSIS_MODEL,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_ID,
  getMusicProvider,
} from "./providers/index.js";

const MCP_PATH = "/mcp";
const SERVER_VERSION = "0.5.1";
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

const analyzeInputSchema = {
  provider: providerSchema,
  model: z
    .string()
    .optional()
    .describe(
      "Replicate multimodal audio-understanding model. Omit to use the default analysis model."
    ),
  audio: OpenAIFileSchema.describe(
    "The user's music/audio attachment from the current ChatGPT conversation."
  ),
  question: z
    .string()
    .min(1)
    .describe(
      "The user's concrete question about what is heard in the attached audio."
    ),
  conversationSummary: z
    .string()
    .optional()
    .describe(
      "Optional relevant context from the current ChatGPT conversation, such as creative intent or earlier feedback."
    ),
  analysisFocus: z
    .array(z.string().min(1))
    .max(12)
    .optional()
    .describe(
      "Optional analysis dimensions to emphasize, for example instrumentation, arrangement, structure, melody, harmony, rhythm, mood, production, or performance."
    ),
};

const analysisOutputSchema = {
  status: z.string(),
  provider: z.string(),
  model: z.string(),
  answer: z.string().optional(),
  prompt: z.string().optional(),
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
      version: SERVER_VERSION,
    },
    {
      instructions:
        "This is a UI-less music generation and music-listening MCP for ChatGPT. Use generate_music when the user wants new music. Use analyze_music when the user wants you to listen to an attached audio file and critique, explain, compare, or answer questions about what is heard. Reuse relevant context from the current ChatGPT conversation. Pass native ChatGPT audio attachments directly to the tool; never ask the user to upload the same file again. Replicate is the enabled provider for both generation and multimodal audio understanding.",
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
      if (!authSession?.scope.includes("replicate.read")) return authRequired(baseUrl);

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
      if (!authSession?.scope.includes("replicate.read")) return authRequired(baseUrl);

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
      if (!authSession?.scope.includes("replicate.run")) return authRequired(baseUrl);

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


  server.registerTool(
    "analyze_music",
    {
      title: "Listen to and analyze music",
      description:
        "Send an attached audio file to a multimodal audio-language model on Replicate and return grounded music/audio analysis. Use this for critique, arrangement feedback, instrumentation questions, structural observations, mood, production, and other questions that require actually listening to the audio.",
      inputSchema: analyzeInputSchema,
      outputSchema: analysisOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
      _meta: {
        securitySchemes: OAUTH_SECURITY,
        "openai/fileParams": ["audio"],
        "openai/toolInvocation/invoking": "Listening to the attached audio…",
        "openai/toolInvocation/invoked": "Audio analysis finished.",
      },
    },
    async (args) => {
      if (!authSession?.scope.includes("replicate.run")) return authRequired(baseUrl);

      try {
        const provider = getMusicProvider(args.provider);
        const result = await provider.analyze(authSession.replicateToken, {
          model: args.model,
          audioUrl: args.audio.download_url,
          audioName: args.audio.file_name,
          audioMimeType: args.audio.mime_type,
          question: args.question,
          conversationSummary: args.conversationSummary,
          analysisFocus: args.analysisFocus,
        });

        return {
          content: [
            {
              type: "text",
              text: result.answer,
            },
          ],
          structuredContent: {
            status: "succeeded",
            provider: result.provider,
            model: result.model,
            answer: result.answer,
            prompt: result.prompt,
            audioInputField: result.capabilities.audioField,
          },
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown analysis error.";

        return {
          content: [
            {
              type: "text",
              text: `Music analysis failed: ${message}`,
            },
          ],
          structuredContent: {
            status: "failed",
            provider: args.provider,
            model: args.model || DEFAULT_ANALYSIS_MODEL,
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
  if (process.env.RENDER && !process.env.AUTH_DATA_DIR) {
    console.warn("AUTH_DATA_DIR is not configured. Mount persistent storage before relying on OAuth across Render restarts.");
  }
});
