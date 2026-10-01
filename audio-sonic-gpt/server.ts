import "dotenv/config";

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";\nimport { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const MCP_PATH = "/mcp";
const PORT = Number(process.env.AUDIO_SONIC_PORT ?? 8790);
const ADAPTER_DIR = dirname(fileURLToPath(import.meta.url));\nconst REPO_ROOT = resolve(ADAPTER_DIR, "..");
const VENDOR_DIR = resolve(
  process.env.AUDIO_SONIC_VENDOR_DIR ??
    join(REPO_ROOT, "vendor", "audio-sonic-mcp")
);
const ANALYZER_SCRIPT = join(VENDOR_DIR, "analyze_file.py");
const MAX_UPLOAD_BYTES =
  Number(process.env.AUDIO_SONIC_MAX_UPLOAD_MB ?? 100) * 1024 * 1024;

const OpenAIFileSchema = z.object({
  download_url: z.string().url(),
  file_id: z.string().min(1),
  mime_type: z.string().optional(),
  file_name: z.string().optional(),
});

type OpenAIFile = z.infer<typeof OpenAIFileSchema>;
type JobStatus = "queued" | "running" | "success" | "error";

type AnalysisJob = {
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  fileName?: string;
  startSec?: number;
  endSec?: number;
  result?: Record<string, unknown>;
  error?: string;
  stderrTail?: string;
};

const jobs = new Map<string, AnalysisJob>();

const MIME_EXTENSIONS: Record<string, string> = {
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/flac": ".flac",
  "audio/ogg": ".ogg",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/aac": ".aac",
};

function nowSeconds(): number {
  return Date.now() / 1000;
}

function safeFileName(file: OpenAIFile): string {
  const supplied = file.file_name?.trim();
  const fromMime = file.mime_type ? MIME_EXTENSIONS[file.mime_type] : undefined;
  const fallback = `audio${fromMime ?? ".mp3"}`;
  return basename(supplied || fallback).replace(/[^a-zA-Z0-9._-]/g, "_");
}

function resolvePython(): string {
  const configured = process.env.AUDIO_SONIC_PYTHON?.trim();
  if (configured) return configured;

  const candidate =
    process.platform === "win32"
      ? join(VENDOR_DIR, ".venv", "Scripts", "python.exe")
      : join(VENDOR_DIR, ".venv", "bin", "python");

  return existsSync(candidate) ? candidate : "python";
}

function ffmpegCommand(): string {
  return process.env.AUDIO_SONIC_FFMPEG?.trim() || "ffmpeg";
}

function appendLimited(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  return next.length > 200_000 ? next.slice(-200_000) : next;
}

async function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk);
    });

    child.on("error", (error) => rejectPromise(error));
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }

      rejectPromise(
        new Error(
          `${command} exited with code ${code}. ${stderr.slice(-4000) || stdout.slice(-2000)}`
        )
      );
    });
  });
}

async function downloadAttachment(
  file: OpenAIFile,
  targetDir: string
): Promise<string> {
  const response = await fetch(file.download_url);
  if (!response.ok) {
    throw new Error(
      `Unable to download ChatGPT audio attachment (HTTP ${response.status}).`
    );
  }

  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_UPLOAD_BYTES) {
    throw new Error(
      `Audio attachment is larger than the configured limit (${Math.round(
        MAX_UPLOAD_BYTES / 1024 / 1024
      )} MB).`
    );
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error(
      `Audio attachment is larger than the configured limit (${Math.round(
        MAX_UPLOAD_BYTES / 1024 / 1024
      )} MB).`
    );
  }

  const target = join(targetDir, safeFileName(file));
  await writeFile(target, bytes);
  return target;
}

async function trimAudioIfRequested(
  inputPath: string,
  targetDir: string,
  startSec?: number,
  endSec?: number
): Promise<string> {
  if (startSec === undefined && endSec === undefined) return inputPath;

  const start = startSec ?? 0;
  if (start < 0) throw new Error("startSec must be >= 0.");
  if (endSec !== undefined && endSec <= start) {
    throw new Error("endSec must be greater than startSec.");
  }

  const output = join(targetDir, "selected-segment.wav");
  const args = ["-y"];

  if (start > 0) args.push("-ss", String(start));
  args.push("-i", inputPath);

  if (endSec !== undefined) {
    args.push("-t", String(endSec - start));
  }

  args.push(
    "-vn",
    "-acodec",
    "pcm_s16le",
    "-ar",
    "44100",
    "-ac",
    "2",
    output
  );

  await runProcess(ffmpegCommand(), args);
  return output;
}

function parseAnalyzerJson(stdout: string): Record<string, unknown> {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("Audio Sonic analyzer did not return JSON.");
  }
  return JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>;
}

async function executeAnalysis(
  jobId: string,
  file: OpenAIFile,
  startSec?: number,
  endSec?: number
): Promise<void> {
  const current = jobs.get(jobId);
  if (!current) return;

  jobs.set(jobId, {
    ...current,
    status: "running",
    updatedAt: nowSeconds(),
  });

  const tempRoot = await mkdtemp(join(tmpdir(), "audio-sonic-gpt-"));

  try {
    if (!existsSync(ANALYZER_SCRIPT)) {
      throw new Error(
        `Vendored Audio Sonic analyzer was not found at ${ANALYZER_SCRIPT}.`
      );
    }

    const downloadedPath = await downloadAttachment(file, tempRoot);
    const analysisInput = await trimAudioIfRequested(
      downloadedPath,
      tempRoot,
      startSec,
      endSec
    );

    const jobsRoot = join(tempRoot, "jobs");
    await mkdir(jobsRoot, { recursive: true });

    const python = resolvePython();
    const { stdout, stderr } = await runProcess(
      python,
      [ANALYZER_SCRIPT, analysisInput, "--no-vector"],
      {
        cwd: VENDOR_DIR,
        env: {
          ...process.env,
          JOBS_ROOT: jobsRoot,
          KEEP_JOB_FILES: "0",
          PYTHONUNBUFFERED: "1",
        },
      }
    );

    const result = parseAnalyzerJson(stdout);
    const resultRecord = result as {
      header?: { source_metadata?: Record<string, unknown> };
    };

    if (resultRecord.header?.source_metadata) {
      resultRecord.header.source_metadata.original_file_name =
        file.file_name || safeFileName(file);
      if (startSec !== undefined || endSec !== undefined) {
        resultRecord.header.source_metadata.requested_segment = {
          start_sec: startSec ?? 0,
          end_sec: endSec ?? null,
        };
      }
    }

    const latest = jobs.get(jobId);
    if (!latest) return;

    jobs.set(jobId, {
      ...latest,
      status: "success",
      result,
      stderrTail: stderr.slice(-4000) || undefined,
      updatedAt: nowSeconds(),
    });
  } catch (error) {
    const latest = jobs.get(jobId);
    if (!latest) return;

    jobs.set(jobId, {
      ...latest,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
      updatedAt: nowSeconds(),
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

function createAudioSonicServer(): McpServer {
  const server = new McpServer(
    {
      name: "audio-sonic-gpt",
      version: "0.1.0",
    },
    {
      instructions:
        "Use this server when the user wants factual analysis of a music/audio attachment. Call submit_music_analysis with the native ChatGPT audio attachment, then poll get_music_analysis until the job succeeds or errors. Treat the returned sonic signature as measured/model-derived evidence. The vendored Audio Sonic MCP runs locally and does not require an external model API.",
    }
  );

  server.registerTool(
    "submit_music_analysis",
    {
      title: "Analyze attached music",
      description:
        "Submit a ChatGPT audio attachment for local Audio Sonic analysis. Returns immediately with a job ID. After submitting, call get_music_analysis with that job ID until status is success or error. Optional startSec/endSec analyzes only a requested segment.",
      inputSchema: {
        audio: OpenAIFileSchema,
        startSec: z.number().min(0).optional(),
        endSec: z.number().positive().optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: {
        "openai/fileParams": ["audio"],
        "openai/toolInvocation/invoking": "Submitting music for local analysis…",
        "openai/toolInvocation/invoked": "Music analysis job submitted.",
      },
    },
    async (args) => {
      if (
        args.startSec !== undefined &&
        args.endSec !== undefined &&
        args.endSec <= args.startSec
      ) {
        return {
          content: [
            {
              type: "text",
              text: "endSec must be greater than startSec.",
            },
          ],
          structuredContent: {
            status: "error",
            error: "endSec must be greater than startSec.",
          },
          isError: true,
        };
      }

      const jobId = `music_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
      const timestamp = nowSeconds();

      jobs.set(jobId, {
        status: "queued",
        createdAt: timestamp,
        updatedAt: timestamp,
        fileName: args.audio.file_name,
        startSec: args.startSec,
        endSec: args.endSec,
      });

      void executeAnalysis(
        jobId,
        args.audio,
        args.startSec,
        args.endSec
      );

      return {
        content: [
          {
            type: "text",
            text: `Audio Sonic analysis job ${jobId} was submitted. Poll get_music_analysis until it completes.`,
          },
        ],
        structuredContent: {
          jobId,
          status: "queued",
          fileName: args.audio.file_name,
          startSec: args.startSec,
          endSec: args.endSec,
        },
      };
    }
  );

  server.registerTool(
    "get_music_analysis",
    {
      title: "Get music analysis",
      description:
        "Check a previously submitted Audio Sonic analysis job. If status is queued or running, call again later in the same workflow. On success, use the returned sonic signature to answer the user's music question.",
      inputSchema: {
        jobId: z.string().min(1),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: {
        "openai/toolInvocation/invoking": "Checking music analysis…",
        "openai/toolInvocation/invoked": "Music analysis status loaded.",
      },
    },
    async ({ jobId }) => {
      const job = jobs.get(jobId);
      if (!job) {
        return {
          content: [
            {
              type: "text",
              text: `Analysis job ${jobId} was not found.`,
            },
          ],
          structuredContent: {
            jobId,
            status: "error",
            error: "job_not_found",
          },
          isError: true,
        };
      }

      if (job.status === "success") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(job.result),
            },
          ],
          structuredContent: {
            jobId,
            status: job.status,
            result: job.result,
          },
        };
      }

      if (job.status === "error") {
        return {
          content: [
            {
              type: "text",
              text: job.error || "Audio Sonic analysis failed.",
            },
          ],
          structuredContent: {
            jobId,
            status: job.status,
            error: job.error,
          },
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Analysis job ${jobId} is ${job.status}.`,
          },
        ],
        structuredContent: {
          jobId,
          status: job.status,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
        },
      };
    }
  );

  server.registerTool(
    "check_audio_sonic_health",
    {
      title: "Check Audio Sonic health",
      description:
        "Check whether the local Python runtime, FFmpeg, and vendored Audio Sonic analyzer are available before running a music analysis.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      const python = resolvePython();
      const checks: Record<string, unknown> = {
        vendorDir: VENDOR_DIR,
        analyzerPresent: existsSync(ANALYZER_SCRIPT),
        python,
        ffmpeg: ffmpegCommand(),
      };

      try {
        const pythonResult = await runProcess(python, ["--version"]);
        checks.pythonStatus = "ok";
        checks.pythonVersion =
          (pythonResult.stdout || pythonResult.stderr).trim();
      } catch (error) {
        checks.pythonStatus = "error";
        checks.pythonError =
          error instanceof Error ? error.message : String(error);
      }

      try {
        const ffmpegResult = await runProcess(ffmpegCommand(), ["-version"]);
        checks.ffmpegStatus = "ok";
        checks.ffmpegVersion = ffmpegResult.stdout.split("\n")[0]?.trim();
      } catch (error) {
        checks.ffmpegStatus = "error";
        checks.ffmpegError =
          error instanceof Error ? error.message : String(error);
      }

      const healthy =
        checks.analyzerPresent === true &&
        checks.pythonStatus === "ok" &&
        checks.ffmpegStatus === "ok";

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ status: healthy ? "ok" : "degraded", checks }),
          },
        ],
        structuredContent: {
          status: healthy ? "ok" : "degraded",
          checks,
        },
        isError: !healthy,
      };
    }
  );

  return server;
}

const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end("Missing URL");
    return;
  }

  const requestUrl = new URL(
    req.url,
    `http://${req.headers.host ?? "localhost"}`
  );

  if (req.method === "OPTIONS" && requestUrl.pathname === MCP_PATH) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, mcp-session-id",
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
          name: "Audio Sonic GPT",
          version: "0.1.0",
          status: "ok",
          ui: false,
          mcp: MCP_PATH,
          localAnalysis: true,
          externalModelApiRequired: false,
          vendorDir: VENDOR_DIR,
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

    const server = createAudioSonicServer();
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
      console.error("Audio Sonic MCP request failed:", error);
      if (!res.headersSent) {
        res.writeHead(500).end("Internal server error");
      }
    }
    return;
  }

  res.writeHead(404).end("Not Found");
});

httpServer.listen(PORT, "127.0.0.1", () => {
  console.log(
    `Audio Sonic GPT listening on http://127.0.0.1:${PORT}${MCP_PATH}`
  );
  console.log(`Vendored analyzer: ${ANALYZER_SCRIPT}`);
  console.log(`Python: ${resolvePython()}`);
});
