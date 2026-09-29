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

import { generateMusic } from "./replicate.js";

const here = dirname(fileURLToPath(import.meta.url));
const widgetHtml = readFileSync(
  resolve(here, "../public/audio-widget.html"),
  "utf8"
);

const WIDGET_URI = "ui://widget/gpt-audio-studio.html";
const MCP_PATH = "/mcp";

const OpenAIFileSchema = z.object({
  download_url: z.string().url(),
  file_id: z.string().min(1),
  mime_type: z.string().optional(),
  file_name: z.string().optional(),
});

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
  conversationSummary: z.string().min(1),
  directorPrompt: z.string().min(1),
  duration: z.number().int().min(1).max(30).default(8),
  referenceAudio: OpenAIFileSchema.optional(),
  continuation: z.boolean().default(false),
};

function createAudioServer(): McpServer {
  const server = new McpServer(
    {
      name: "gpt-audio-plugin-server",
      version: "0.1.0",
    },
    {
      instructions:
        "Before open_audio_studio, reuse the current chat as the reasoning layer: summarize only relevant music context into conversationSummary and draft a production-ready directorPrompt. The plugin must not call a separate text model. The user can edit both fields before the billable Replicate generation.",
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
              "Review the current ChatGPT music context and director prompt, optionally add reference audio, and generate through Replicate.",
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
        "Open the music creation UI. Pass both a concise conversationSummary and a production-ready directorPrompt created by the current ChatGPT model, so the plugin can reuse the chat without a separate text-model API.",
      inputSchema: studioInputSchema,
      outputSchema: studioOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: {
        ui: { resourceUri: WIDGET_URI },
        "openai/widgetAccessible": true,
      },
    },
    async (args) => {
      return {
        content: [
          {
            type: "text",
            text: "Audio studio opened with the current conversation context and ChatGPT director prompt.",
          },
        ],
        structuredContent: {
          status: "ready",
          conversationSummary: args.conversationSummary ?? "",
          directorPrompt: args.directorPrompt ?? "",
        },
      };
    }
  );

  registerAppTool(
    server,
    "generate_music",
    {
      title: "Generate music with Replicate",
      description:
        "Create a billable Replicate music prediction using conversationSummary, the ChatGPT-authored directorPrompt, and optional uploaded or recorded referenceAudio.",
      inputSchema: generateInputSchema,
      outputSchema: studioOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
      _meta: {
        ui: { resourceUri: WIDGET_URI },
        "openai/widgetAccessible": true,
        "openai/fileParams": ["referenceAudio"],
        "openai/toolInvocation/invoking": "Generating music with Replicate…",
        "openai/toolInvocation/invoked": "Music generation finished.",
      },
    },
    async (args) => {
      try {
        const result = await generateMusic({
          conversationSummary: args.conversationSummary,
          directorPrompt: args.directorPrompt,
          duration: args.duration ?? 8,
          referenceAudioUrl: args.referenceAudio?.download_url,
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
          content: [{ type: "text", text: `Music generation failed: ${message}` }],
          structuredContent: {
            status: "failed",
            conversationSummary: args.conversationSummary,
            directorPrompt: args.directorPrompt,
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

const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end("Missing URL");
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "OPTIONS" && url.pathname === MCP_PATH) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, mcp-session-id",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(
        JSON.stringify({
          name: "GPTAudioPlugin",
          status: "ok",
          mcp: MCP_PATH,
          replicateConfigured: Boolean(
            process.env.REPLICATE_API_TOKEN?.trim()
          ),
          model:
            process.env.REPLICATE_MODEL?.trim() ||
            "meta/musicgen:671ac645ce5e552cc63a54a2bbff63fcf798043055d2dac5fc9e36a837eedcfb",
        })
      );
    return;
  }

  const allowedMethods = new Set(["POST", "GET", "DELETE"]);
  if (
    url.pathname === MCP_PATH &&
    req.method &&
    allowedMethods.has(req.method)
  ) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

    const server = createAudioServer();
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
});
