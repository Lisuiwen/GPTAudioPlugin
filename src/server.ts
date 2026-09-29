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
  generateMusic,
  inspectReplicateModel,
} from "./replicate.js";

const MCP_PATH = "/mcp";
const OAUTH_SCOPES = ["replicate.read", "replicate.run"];
const OAUTH_SECURITY = [{ type: "oauth2" as const, scopes: OAUTH_SCOPES }];

const OpenAIFileSchema = z.object({
  download_url: z.string().url(),
  file_id: z.string().min(1),
  mime_type: z.string().optional(),
  file_name: z.string().optional(),
});

const capabilitiesOutputSchema = {
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
  model: z
    .string()
    .optional()
    .describe(
      'Replicate model as "owner/name" or "owner/name:version". Omit to use the plugin default.'
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
    "The user's audio attachment from the ChatGPT conversation. Pass the native ChatGPT attachment here when the selected Replicate model supports audio conditioning."
  ),
  continuation: z
    .boolean()
    .default(false)
    .describe(
      "When supported by the selected model, continue/extend the attached reference audio instead of using it only as conditioning."
    ),
};

const generationOutputSchema = {
  status: z.string(),
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

function createAudioServer(
  authSession: AuthSession | undefined,
  baseUrl: string
): McpServer {
  const server = new McpServer(
    {
      name: "gpt-audio-plugin-server",
      version: "0.3.0",
    },
    {
      instructions:
        "GPTAudioPlugin is UI-less. Reuse the current ChatGPT conversation as the reasoning layer. When the user attaches an audio file in ChatGPT, pass that native attachment directly to generate_music.referenceAudio. Compose conversationSummary and directorPrompt from the current chat. Do not ask the user to re-upload the file into a custom UI and do not call a separate text-model API. Protected Replicate tools require the user to connect their own Replicate account.",
    }
  );

  server.registerTool(
    "get_replicate_profile",
    {
      title: "Replicate profile",
      description:
        "Return the Replicate account connected to GPT Audio Plugin.",
      inputSchema: {},
      outputSchema: {
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
    async () => {
      if (!authSession) return authRequired(baseUrl);

      const profile = {
        id: authSession.profileId,
        name: authSession.name || authSession.username,
        nickname: `${authSession.username} — Replicate`,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(profile) }],
        structuredContent: profile,
      };
    }
  );

  server.registerTool(
    "inspect_replicate_model",
    {
      title: "Check Replicate model",
      description:
        "Inspect a Replicate model's input schema. Use this when the user selects a non-default model or when you need to know whether an attached audio file can be passed to it.",
      inputSchema: {
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
        "openai/toolInvocation/invoking": "Checking Replicate model…",
        "openai/toolInvocation/invoked": "Model capabilities loaded.",
      },
    },
    async (args) => {
      if (!authSession) return authRequired(baseUrl);

      try {
        const capabilities = await inspectReplicateModel(
          authSession.replicateToken,
          args.model || DEFAULT_MODEL
        );

        return {
          content: [
            {
              type: "text",
              text: capabilities.supportsAudioInput
                ? `Model ${capabilities.model} supports reference audio via ${capabilities.audioField}.`
                : `Model ${capabilities.model} does not expose a recognizable audio input.`,
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
      title: "Generate music with Replicate",
      description:
        "Generate music from the current ChatGPT conversation and, when present, the user's native ChatGPT audio attachment. The server automatically inspects the selected Replicate model before generation and rejects reference audio if that model does not support audio input.",
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
        "openai/toolInvocation/invoking": "Generating music with Replicate…",
        "openai/toolInvocation/invoked": "Music generation finished.",
      },
    },
    async (args) => {
      if (!authSession) return authRequired(baseUrl);

      try {
        const result = await generateMusic(authSession.replicateToken, {
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
                ? `Generated music with Replicate using the attached audio: ${result.audioUrl}`
                : `Generated music with Replicate: ${result.audioUrl}`,
            },
          ],
          structuredContent: {
            status: "succeeded",
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
          name: "GPTAudioPlugin",
          status: "ok",
          version: "0.3.0",
          ui: false,
          mcp: MCP_PATH,
          oauth: {
            resourceMetadata: `${baseUrl}/.well-known/oauth-protected-resource`,
            authorizationServer: baseUrl,
          },
          model: DEFAULT_MODEL,
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
    const server = createAudioServer(authSession, baseUrl);
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
    `GPTAudioPlugin MCP server listening on http://127.0.0.1:${port}${MCP_PATH}`
  );
  console.log("UI: disabled; use native ChatGPT attachments");
  console.log(`OAuth issuer: ${baseUrl}`);
});
