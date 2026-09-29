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
  contextSummary: z
    .string()
    .describe(
      "A concise summary of the current ChatGPT conversation relevant to the music the user wants to create."
    ),
  initialPrompt: z
    .string()
    .optional()
    .describe("Optional extra music direction already stated by the user."),
};

const studioOutputSchema = {
  status: z.string(),
  contextSummary: z.string(),
  initialPrompt: z.string().optional(),
  audioUrl: z.string().optional(),
  model: z.string().optional(),
  prompt: z.string().optional(),
  error: z.string().optional(),
};

const generateInputSchema = {
  contextSummary: z.string().min(1),
  prompt: z.string().optional(),
  duration: z.number().int().min(1).max(30).default(8),
  referenceAudio: OpenAIFileSchema.optional(),
  continuation: z.boolean().default(false),
};

function createAudioServer(): McpServer {
  const server = new McpServer({
    name: "gpt-audio-plugin-server",
    version: "0.1.0",
  });

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
            "openai/widgetDescription":
              "Create music from the current ChatGPT context and optional reference audio.",
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
        "Open the music creation UI. Pass a concise summary of the current conversation as contextSummary so the user can reuse the chat as creative direction without a separate text-model API.",
      inputSchema: studioInputSchema,
      outputSchema: studioOutputSchema,
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
            text: "Audio studio opened with the current conversation context.",
          },
        ],
        structuredContent: {
          status: "ready",
          contextSummary: args.contextSummary ?? "",
          initialPrompt: args.initialPrompt,
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
        "Generate music using the configured Replicate account. The creative direction comes from contextSummary plus optional user prompt. referenceAudio can be an uploaded or recorded clip.",
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
      },
    },
    async (args) => {
      try {
        const result = await generateMusic({
          contextSummary: args.contextSummary,
          prompt: args.prompt,
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
            contextSummary: args.contextSummary,
            initialPrompt: args.prompt,
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
            contextSummary: args.contextSummary,
            initialPrompt: args.prompt,
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
