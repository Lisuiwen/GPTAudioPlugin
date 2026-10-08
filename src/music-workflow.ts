import type { GenerateMusicInput } from "./providers/types.js";
import {
  createRunwareTask,
  getRunwareTask,
  cancelRunwareTask,
  prepareRunwareGeneration,
  type RunwarePredictionState,
} from "./providers/runware.js";
import { AudioAssets, WorkflowStore, newId, sha256, type RecordValue } from "./workflow-store.js";

export type NativeAudio = { download_url: string; file_id: string; mime_type?: string; file_name?: string };
export type Source = { audioId?: string; audio?: NativeAudio };
type Job = RecordValue & {
  kind: "job";
  action: string;
  provider?: string;
  status: string;
  requestKey: string;
  fingerprint: string;
  createdAt: number;
  updatedAt: number;
  predictionId?: string;
  model?: string;
  modelVersion?: string;
  prompt?: string;
  sourceAudioId?: string;
  mode?: string;
  warnings: string[];
  audioFormat?: string;
  providerOutput?: unknown;
  providerCostUsd?: number;
  result?: Record<string, unknown>;
  finalizingUntil?: number;
};
class ResultShapeError extends Error {}
const terminal = new Set(["succeeded", "failed", "canceled"]);
// Canonicalize request inputs before deriving the idempotency fingerprint.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)])
    );
  }
  return value;
}

// Runware returns audio URLs as a flat list; legacy provider response shapes are not accepted.
function runwareAudioUrls(output: unknown): string[] {
  return Array.isArray(output) ? output.filter((value): value is string => typeof value === "string") : [];
}
export class MusicWorkflow {
  constructor(
    readonly store: WorkflowStore,
    readonly assets: AudioAssets,
    readonly runwareApiKey?: string
  ) {}

  // Resolve a user-owned audio source before a provider submission.
  private async source(owner: string, source: Source) {
    if (source.audioId && source.audio) throw new Error("Pass an audioId or an attachment, not both.");
    if (source.audioId) return this.assets.require(owner, source.audioId);
    if (source.audio) {
      return this.assets.register(owner, {
        url: source.audio.download_url,
        fileName: source.audio.file_name,
        mimeType: source.audio.mime_type,
      });
    }
    return undefined;
  }

  // Reserve the request key and task UUID before the billable Runware submission.
  async submit(
    owner: string,
    request: GenerateMusicInput,
    source: Source,
    requestKey = newId("request")
  ) {
    if (requestKey.length > 128 || !/^[\w.-]+$/.test(requestKey)) {
      throw new Error("requestKey must be 1–128 letters, digits, underscores, dots or hyphens.");
    }
    if (source.audioId && source.audio) throw new Error("Pass exactly one audio source.");
    const fingerprint = await sha256(
      JSON.stringify(
        canonical({
          action: "generate",
          request,
          source: { audioId: source.audioId, fileId: source.audio?.file_id },
        })
      )
    );
    const prior = await this.store.findRequest<Job>(owner, requestKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new Error("requestKey was already used with different inputs. Use a new key for a new operation.");
      }
      return this.view(prior);
    }

    const job: Job = {
      id: newId("job"),
      kind: "job",
      revision: 0,
      action: "generate",
      provider: "runware",
      status: "preparing",
      requestKey,
      fingerprint,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      warnings: [],
    };
    if (!(await this.store.insert(owner, job, requestKey))) {
      const existing = await this.store.findRequest<Job>(owner, requestKey);
      if (!existing) {
        throw new Error(
          "At most three active or unreconciled music jobs are allowed per user. Finish or cancel an existing job before creating another."
        );
      }
      if (existing.fingerprint !== fingerprint) throw new Error("Concurrent request-key conflict.");
      return this.view(existing);
    }

    let startingPrediction = false;
    try {
      const audio = await this.source(owner, source);
      const file = audio ? await this.assets.file(owner, audio.id) : undefined;
      job.sourceAudioId = audio?.id;

      if (!this.runwareApiKey?.trim()) {
        throw new Error("Runware generation is not configured on this deployment.");
      }
      const plan = prepareRunwareGeneration({
        ...request,
        referenceAudioFile: file,
      });
      // Persist the task UUID before submission so an uncertain response can be reconciled.
      job.predictionId = plan.taskUUID;
      Object.assign(job, {
        model: plan.model,
        modelVersion: plan.version,
        prompt: plan.prompt,
        mode: plan.mode,
        warnings: plan.warnings,
        status: "submitting",
        updatedAt: Date.now(),
        audioFormat: request.audioFormat || "mp3",
      });
      if (!(await this.store.update(owner, job))) {
        throw new Error("Job changed before submission; no prediction was started.");
      }

      startingPrediction = true;
      const prediction = await createRunwareTask(this.runwareApiKey!, plan);
      job.predictionId = prediction.id;
      job.status = prediction.status;
      if (prediction.metrics?.cost !== undefined) job.providerCostUsd = prediction.metrics.cost;
      job.updatedAt = Date.now();
      if (!(await this.store.update(owner, job))) throw new Error("Cannot persist prediction receipt.");
      return this.apply(owner, job, prediction);
    } catch (error) {
      // An uncertain provider response must be reconciled by task UUID, never resubmitted.
      job.status = startingPrediction ? "submission_unknown" : "failed";
      job.updatedAt = Date.now();
      job.result = {
        error: startingPrediction
          ? "Submission outcome requires reconciliation. Reuse this requestKey and poll this job; do not submit a new billable job blindly."
          : error instanceof Error
            ? error.message
            : "Input preparation failed.",
      };
      await this.store.update(owner, job);
      return this.view(job);
    }
  }

  // Load a job only when it belongs to the authenticated owner.
  private async require(owner: string, id: string) {
    const job = await this.store.get<Job>(owner, id);
    if (!job || job.kind !== "job") throw new Error("Job not found or not owned by this user.");
    return job;
  }

  // Read an existing job without creating another inference task.
  async get(owner: string, id: string) {
    const job = await this.require(owner, id);
    if (terminal.has(job.status)) return this.view(job);
    if (job.provider !== "runware") throw new Error("Legacy listening jobs can no longer be polled.");
    if (job.status === "finalizing" && (job.finalizingUntil || 0) > Date.now()) return this.view(job);
    if (job.providerOutput !== undefined && ["storage_pending", "finalizing"].includes(job.status)) {
      return this.apply(owner, job, {
        id: job.predictionId!,
        status: "succeeded",
        output: job.providerOutput,
        metrics: job.providerCostUsd !== undefined ? { cost: job.providerCostUsd } : undefined,
      });
    }
    if (!job.predictionId) return this.view(job);

    if (!this.runwareApiKey?.trim()) throw new Error("Runware generation is not configured on this deployment.");
    return this.apply(owner, job, await getRunwareTask(this.runwareApiKey, job.predictionId));
  }

  // Report Runware cancellation limits without claiming that billing has stopped.
  async cancel(owner: string, id: string) {
    const job = await this.require(owner, id);
    if (terminal.has(job.status)) return this.view(job);
    if (job.provider !== "runware") throw new Error("Legacy listening jobs can no longer be canceled here.");
    if (!job.predictionId) {
      throw new Error("Submission is not yet reconciled. Check this job again; cancellation is not confirmed.");
    }

    if (!this.runwareApiKey?.trim()) throw new Error("Runware generation is not configured on this deployment.");
    const state = await cancelRunwareTask(this.runwareApiKey, job.predictionId);
    return this.apply(owner, job, state);
  }

  // Persist provider progress and import completed audio under the job owner's identity.
  private async apply(owner: string, job: Job, prediction: RunwarePredictionState): Promise<Record<string, unknown>> {
    if (prediction.metrics?.cost !== undefined) job.providerCostUsd = prediction.metrics.cost;

    if (prediction.status !== "succeeded") {
      job.status = prediction.status;
      job.updatedAt = Date.now();
      if (["failed", "canceled"].includes(prediction.status)) {
        const providerName = "Runware";
        const detail =
          typeof prediction.error === "string"
            ? prediction.error
            : prediction.error
              ? JSON.stringify(prediction.error)
              : "";
        job.result = {
          error: `${providerName} task ${prediction.id} is ${prediction.status}.${detail ? ` ${detail}` : ""}`,
        };
      }
      if (!(await this.store.update(owner, job))) return this.view(await this.require(owner, job.id));
      return this.view(job);
    }

    job.providerOutput = prediction.output;
    job.status = "finalizing";
    job.finalizingUntil = Date.now() + 120000;
    if (!(await this.store.update(owner, job))) return this.view(await this.require(owner, job.id));

    try {
      const urls = runwareAudioUrls(prediction.output);
      if (!urls.length) throw new ResultShapeError("No generated audio was returned.");
      if (urls.length > 4) throw new Error("Unexpectedly many output files.");
      const audios = [];
      const providerRetentionMs = 7 * 24 * 60 * 60 * 1000;
      for (let index = 0; index < urls.length; index++) {
        const audio = await this.assets.register(
          owner,
          {
            url: urls[index],
            fileName: job.id + "-" + index + "." + job.audioFormat,
            mimeType: job.audioFormat === "wav" ? "audio/wav" : "audio/mpeg",
            expiresAt: job.createdAt + providerRetentionMs,
            parentAudioId: job.sourceAudioId,
          },
          "audio_" + job.id + "_" + index
        );
        audios.push(this.assets.view(audio));
      }
      job.result = {
        audioId: audios[0].audioId,
        audioIds: audios.map((audio) => audio.audioId),
        audioUrl: urls[0],
        audioUrls: urls,
        audios,
        referenceAudioUsed: !!job.sourceAudioId,
        sourceAudioId: job.sourceAudioId,
        ...(job.providerCostUsd !== undefined ? { providerCostUsd: job.providerCostUsd } : {}),
      };
      job.status = "succeeded";
      delete job.providerOutput;
    } catch (error) {
      job.status = error instanceof ResultShapeError ? "failed" : "storage_pending";
      job.result = {
        error:
          error instanceof ResultShapeError
            ? error.message
            : "Provider generation completed, but output import is incomplete. Poll the same job to retry import without generating again.",
        audioUrls: runwareAudioUrls(prediction.output),
        ...(job.providerCostUsd !== undefined ? { providerCostUsd: job.providerCostUsd } : {}),
      };
    }
    job.updatedAt = Date.now();
    delete job.finalizingUntil;
    if (!(await this.store.update(owner, job))) return this.view(await this.require(owner, job.id));
    return this.view(job);
  }

  // Return a stable, owner-scoped job view to MCP callers.
  view(job: Job): Record<string, unknown> {
    return {
      jobId: job.id,
      requestKey: job.requestKey,
      status: job.status,
      provider: job.provider || "legacy",
      predictionId: job.predictionId,
      model: job.model,
      modelVersion: job.modelVersion,
      generationMode: job.mode,
      effectivePrompt: job.prompt,
      prompt: job.prompt,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      warnings: job.warnings,
      ...(job.providerCostUsd !== undefined ? { providerCostUsd: job.providerCostUsd } : {}),
      pollAfterSeconds: terminal.has(job.status) ? undefined : 3,
      ...job.result,
    };
  }
}
