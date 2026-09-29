import "dotenv/config";

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
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

const here = dirname(fileURLToPath(import.meta.url));
const widgetHtml = readFileSync(
  resolve(here, "../public/audio-widget.html"),
  "utf8"
);

const WIDGET_URI = "ui://widget/gpt-audio-studio.html";
const MCP_PATH = "/mcp";
const OAUTH_SCOPES = ["replicate.read", "replicate.run"];
const OAUTH_SECURITY = [{ type: "oauth2" as const, scopes: OAUTH_SCOPES }];
const NOAUTH_SECURITY = [{ type: "noauth" as const }];

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

const studioInputSchema = {
  conversationSummary: z
    .string()
    .describe(
      "A concise summary of the current ChatGPT conversation relevant to the music the user wants to create."
    ),
  directorPrompt: z
    .string()
    .describe(
      "A production-ready music direction drafted by the current ChatGPT model from the conversation. Do not call a separate text-model API."
    ),
};

const studioOutputSchema = {
  status: z.string(),
  conversationSummary: z.string(),
  directorPrompt: z.string().optional(),
  audioUrl: z.string().optional(),
  model: z.string().optional(),
  prompt: z.string().optional(),
  error: z.string().optional(),
};

const generateInputSchema = {
  model: z
    .string()
    .optional()
    .describe(
      'Replicate model as "owner/name" or "owner/name:version". Defaults to the plugin model.'
    ),
  conversationSummary: z.string().min(1),
  directorPrompt: z.string().min(1),
  duration: z.number().int().min(1).max(30).default(8),
  referenceAudio: OpenAIFileSchema.optional(),
  continuation: z.boolean().default(false),
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
      version: "0.2.0",
    },
    {
      instructions:
        "Reuse the current ChatGPT conversation as the text reasoning layer. Before open_audio_studio, summarize relevant music context into conversationSummary and draft a production-ready directorPrompt. Protected Replicate tools require the user to connect their own Replicate account through OAuth.",
    }
  );

  registerAppResource(
    server,
    "gpt-audio-studio",
    WIDGET_URI,
    {},
    async () => ({
      contents: [
        {
          uri: WIDGET_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: widgetHtml,
          _meta: {
            ui: {
              prefersBorder: true,
              csp: {
                connectDomains: [],
                resourceDomains: [
                  "https://replicate.delivery",
                  "https://*.replicate.delivery",
                ],
              },
            },
            "openai/ui": {
              availableDisplayModes: ["inline", "fullscreen"],
            },
            "openai/widgetDescription":
              "Review ChatGPT's music direction, connect a Replicate account, inspect model capabilities, optionally add reference audio, and generate music.",
          },
        },
      ],
    })
  );

  registerAppTool(
    server,
    "open_audio_studio",
    {
      title: "Open audio studio",
      description:
        "Open the music creation UI using the current ChatGPT conversation summary and ChatGPT-authored music director prompt.",
      inputSchema: studioInputSchema,
      outputSchema: studioOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      securitySchemes: NOAUTH_SECURITY,
      _meta: {
        securitySchemes: NOAUTH_SECURITY,
        ui: { resourceUri: WIDGET_URI },
        "openai/widgetAccessible": true,
      },
    } as any,
    async (args) => ({
      content: [
        {
          type: "text",
          text: "Audio studio opened. Connect Replicate before inspecting a model or generating music.",
        },
      ],
      structuredContent: {
        status: "ready",
        conversationSummary: args.conversationSummary ?? "",
        directorPrompt: args.directorPrompt ?? "",
        model: DEFAULT_MODEL,
      },
    })
  );

  registerAppTool(
    server,
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
      securitySchemes: OAUTH_SECURITY,
      _meta: {
        securitySchemes: OAUTH_SECURITY,
        "openai/profile": true,
      },
    } as any,
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

  registerAppTool(
    server,
    "inspect_replicate_model",
    {
      title: "Check Replicate model",
      description:
        "Inspect a Replicate model's input schema before generation. Use this to determine whether the selected model supports reference audio and which inputs the plugin can map.",
      inputSchema: {
        model: z.string().default(DEFAULT_MODEL),
      },
      outputSchema: capabilitiesOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      securitySchemes: OAUTH_SECURITY,
      _meta: {
        securitySchemes: OAUTH_SECURITY,
        ui: { resourceUri: WIDGET_URI },
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "Checking Replicate model…",
        "openai/toolInvocation/invoked": "Model capabilities loaded.",
      },
    } as any,
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

  registerAppTool(
    server,
    "generate_music",
    {
      title: "Generate music with Replicate",
      description:
        "Create a billable Replicate prediction using the connected user's Replicate account. The model is inspected first; reference audio is rejected when the selected model does not support it.",
      inputSchema: generateInputSchema,
      outputSchema: studioOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
      securitySchemes: OAUTH_SECURITY,
      _meta: {
        securitySchemes: OAUTH_SECURITY,
        ui: { resourceUri: WIDGET_URI },
        "openai/widgetAccessible": true,
        "openai/fileParams": ["referenceAudio"],
        "openai/toolInvocation/invoking": "Generating music with Replicate…",
        "openai/toolInvocation/invoked": "Music generation finished.",
      },
    } as any,
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

        return {
          content: [
            {
              type: "text",
              text: `Generated music with Replicate: ${result.audioUrl}`,
            },
          ],
          structuredContent: {
            status: "succeeded",
            conversationSummary: args.conversationSummary,
            directorPrompt: args.directorPrompt,
            audioUrl: result.audioUrl,
            model: result.model,
            prompt: result.prompt,
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
            conversationSummary: args.conversationSummary,
            directorPrompt: args.directorPrompt,
            model: args.model || DEFAULT_MODEL,
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
          version: "0.2.0",
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
  console.log(`OAuth issuer: ${baseUrl}`);
});
