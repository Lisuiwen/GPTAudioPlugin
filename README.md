# GPTAudioPlugin / GPTAudioMCP 0.8.0

A UI-less ChatGPT/Sites MCP for **hosted ACE-Step 1.5 music generation/editing on Runware** plus grounded audio listening on Replicate. ChatGPT supplies creative direction; the service validates provider capabilities, executes billable operations, and stores user-owned jobs/audio references.

## Architecture

```text
ChatGPT / Codex
  -> Sites gateway + trusted user identity
  -> src/worker.ts
  -> src/music-server.ts
       |-> Runware ACE-Step 1.5 XL Turbo / XL Base (generation + audio editing)
       |-> Replicate Qwen audio model (listening / critique)
  -> persistent workflow
  -> audioId reuse -> listen / edit again
```

The Node entry `src/server.ts` keeps the existing local OAuth flow and uses the same tool contract. Sites never imports Node HTTP/filesystem/SQLite modules. Node 22.13+ is required for the local SQLite adapter.

## Provider split

| Intent | Provider / model |
| --- | --- |
| New music | Runware `runware:ace-step@v1.5-xl-turbo` |
| Reference-audio transformation / cover | Runware ACE-Step 1.5 XL Turbo |
| Localized repaint | Runware ACE-Step 1.5 XL Turbo |
| Continuation / extension | Runware ACE-Step 1.5 XL Turbo |
| Higher-quality slower edit | Runware `runware:ace-step@v1.5-xl-base` |
| Listening / critique | Replicate `lucataco/qwen2.5-omni-7b` |

Runware generation credentials are deployment-side: set `RUNWARE_API_KEY`. Users no longer need to connect Replicate to generate music. The existing encrypted Replicate connection is retained only for listening/analysis.

The hosted Runware ACE-Step schema currently exposes text/audio generation, source-audio strength, and repaint/extension ranges. The XL Base model description mentions `extract`, `lego`, and `complete`, but those task selectors are not exposed by the current public hosted schema, so GPTAudioMCP 0.8.0 does **not** claim those operations.

## Tools

| Tool | Behavior |
| --- | --- |
| `get_service_status` | Version, build SHA, providers/models, storage mode and runtime configuration. |
| `get_music_provider_profile` | Runware deployment status or connected Replicate listening identity. |
| `inspect_music_model` | Read Runware hosted capability contract or live Replicate schema. |
| `generate_music` | Generate or transform music with Runware ACE-Step 1.5. |
| `analyze_music` | Listen to an attachment/audioId through Replicate; optional PCM WAV range crop. |
| `get_music_job` | Reconcile/poll an existing provider task and import completed output. Never regenerates. |
| `cancel_music_job` | Cancel where supported. Runware audio inference has no server-side cancellation. |
| `register_music_audio` | Register a native attachment as a reusable user-owned audioId. |
| `get_music_audio` | Read asset metadata and parent/version lineage. |
| `delete_music_audio` | Delete owned service bytes/metadata on explicit request. |
| `compare_music` | Two independent Replicate listens using the same rubric, then ChatGPT synthesizes. |

Native file parameters declare `download_url` and `file_id` as required; `mime_type` and `file_name` are optional. Never invent a ChatGPT file ID for generated audio: reuse the returned service `audioId`.

## Runware generation contract

`generationMode` is:

```text
auto | generate | cover | reference | repaint | continue
```

For **new generation**, hosted Runware ACE-Step currently accepts 30–300 seconds. For requests with source audio, Runware does not accept `duration`; use `repaintingStart` / `repaintingEnd` to define a replacement or extension. Values beyond the source duration can append audio; negative repaint starts can prepend audio.

Relevant inputs:

- `directorPrompt`: 2–3000 characters
- `lyrics`: up to 3000 characters
- `instrumental` / `autoLyrics`
- `seed`
- `audioFormat`: MP3 or WAV through the MCP tool
- `referenceAudio` or `sourceAudioId`
- `strength`: 0–1 source influence
- `repaintingStart`, `repaintingEnd`

XL Turbo is the default because it is materially faster/cheaper. Select XL Base explicitly when quality is more important than latency/cost.

Every Runware task sends `includeCost: true`; completed generation results may therefore include `providerCostUsd`.

## Billing/idempotency safeguards

1. Supply a stable `requestKey` for each logical operation.
2. Repeating the same key + same inputs returns the existing job.
3. Reusing a key with changed inputs fails before a new billable request.
4. The Runware `taskUUID` is persisted **before** the network submission.
5. If the submission response is lost, the job becomes `submission_unknown`; `get_music_job` reconciles that UUID with Runware instead of blindly resubmitting.
6. If generation finished but audio import failed, `storage_pending` retries storage from the existing provider output without generating again.

At most three active/unreconciled jobs are accepted per user.

Runware does not currently provide a server-side cancellation mechanism for these audio inference calls. `cancel_music_job` therefore never claims that stopping the client wait stops Runware billing.

## Audio reuse and listening

A completed generation returns `audioId` / `audioIds`. Pass an `audioId` directly to `analyze_music` or into another generation/edit request; no ChatGPT re-upload is required.

`startSec` / `endSec` perform real sample-aligned slicing for **PCM or IEEE-float WAV** before listening. Full MP3 and other provider-supported formats can still be analyzed as whole files, but compressed segment slicing fails explicitly rather than silently analyzing the wrong range.

Structured analysis is validated as:

```json
{
  "summary": "...",
  "observations": [],
  "uncertainties": [],
  "suggestions": []
}
```

Non-JSON model output remains available as raw `answer` with `structuredStatus: unavailable`; the server does not fabricate observations or confidence.

## Storage and retention

Sites jobs/audio metadata use D1 table `music_records`; encrypted Replicate listening credentials remain in `replicate_connections`.

The Worker accepts an optional R2-compatible `AUDIO_BUCKET` binding. With it, audio bytes are stored under user-scoped opaque keys. Without it, records explicitly report `storage: temporary` and retain only the provider/source URL.

Runware generated URLs are normally available for seven days by default; Replicate outputs have shorter retention. Configure `AUDIO_BUCKET` before claiming durable cloud audio persistence. `get_service_status.durableAudio` is the runtime truth.

Authenticated `GET /audio/{audioId}` serves saved audio through the Sites identity boundary. Explicit deletion removes the service copy, not the original ChatGPT attachment or provider task.

## Configuration

```dotenv
RUNWARE_API_KEY=...
RUNWARE_MODEL=runware:ace-step@v1.5-xl-turbo
RUNWARE_ADVANCED_MODEL=runware:ace-step@v1.5-xl-base

# Listening only
REPLICATE_ANALYSIS_MODEL=lucataco/qwen2.5-omni-7b
```

Never commit provider credentials.

For Sites, keep the existing project, D1 binding and `AUTH_ENCRYPTION_KEY`. Add `RUNWARE_API_KEY` as a deployment secret. The current `.openai/hosting.json` still has `r2: null`, so object storage is not automatically provisioned.

## Build and verification

```powershell
npm ci
npm run typecheck
npm test
```

`npm run build` builds the Node service plus the browser-only Sites Worker at `dist/server/index.js`. The Worker includes the source Git SHA.

`npm run check:mcp -- <endpoint>` verifies the v0.8.0 tool catalog, the 300-second hosted Runware generation ceiling, the new `repaint` mode and the Replicate OAuth challenge without running a billable inference.

Updating GitHub alone does **not** update the live Sites runtime. Publish the build with the existing desktop Sites deployment workflow, then verify `get_service_status` reports:

- version `0.8.0`
- `providers.generation = runware`
- `runwareConfigured = true`

## Local end-to-end debugging

Use a separate worktree rather than disturbing a working checkout.

```powershell
$env:RUNWARE_API_KEY="..."
node scripts/debug-site.mjs
```

Open `http://127.0.0.1:8797/connect` only if you also want Replicate listening. Never paste provider tokens into chat.

Then:

```powershell
# Discovery only, no billable inference
node scripts/live-workflow.mjs

# Billable: one 30-second Runware WAV generation + one cropped Replicate listen
node scripts/live-workflow.mjs --billable
```

The live test uses stable request keys, `audioId` reuse and duplicate-submit checks. It resumes from `.data/live-workflow-report.json` rather than blindly repeating generation.

## Source layout

```text
src/music-server.ts          MCP tool contract / provider split
src/music-workflow.ts        persistent cross-provider workflow
src/workflow-store.ts        user-owned job/audio records
src/audio.ts                 bounded downloads + WAV slicing
src/providers/runware.ts     hosted ACE-Step 1.5 generation/editing
src/providers/replicate.ts   listening model + legacy schema utilities
src/replicate-transport.ts   Replicate prediction transport
src/worker.ts                Sites authenticated entry
src/sites-store.ts           encrypted Replicate listening connection store
src/server.ts                Node OAuth entry
src/node-workflow.ts         local SQLite/filesystem adapters
scripts/debug-site.mjs       loopback Sites harness
scripts/live-workflow.mjs    resumable opt-in live test
```

## Security boundary

The Worker trusts `oai-authenticated-user-id` **only behind the Sites authentication gateway**. Never expose the Worker directly with a caller-controlled identity header.

Existing per-user Replicate token encryption and connection form origin checks are retained. Audio downloads are bounded and reject local/numeric destinations; production should still enforce outbound-network policy for comprehensive SSRF/DNS-rebinding protection.
