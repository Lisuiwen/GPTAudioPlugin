# GPTAudioPlugin / GPTAudioMCP 0.7.1

A UI-less ChatGPT/Sites MCP for **Replicate-only** music generation, audio listening and iterative reuse. ChatGPT supplies creative direction; the service executes validated model operations and stores user-owned jobs/audio references.

## Architecture

```text
ChatGPT / Codex
  -> Sites gateway OAuth + trusted user identity
  -> src/worker.ts
  -> src/music-server.ts (shared tool contract)
  -> Replicate prediction
  -> get_music_job -> persisted audioId -> analyze_music / next generation
```

The Node entry `src/server.ts` keeps the existing local OAuth flow and uses the same tools. Sites never imports the Node HTTP, filesystem or SQLite modules. Node 22.13+ is required for the local SQLite adapter.

## Tools

| Tool | Behavior |
| --- | --- |
| `get_service_status` | Version, build SHA, exact tool list, default models and storage/segment capabilities. No prediction. |
| `get_music_provider_profile` | Connected Replicate identity. |
| `inspect_music_model` | Actual model schema, exact audio field, mode and prompt/duration limits. No prediction. |
| `generate_music` | Generate, cover, melody-reference or continue; returns a job or completed result. |
| `analyze_music` | Listen to an attachment or audioId; optionally crop a PCM WAV range. |
| `get_music_job` | Poll an existing prediction and import completed outputs. Never regenerates. |
| `cancel_music_job` | Request cancellation and report actual provider state, not a zero-cost guarantee. |
| `register_music_audio` | Register an attachment as a user-owned audioId. |
| `get_music_audio` | Read asset metadata and parent/version lineage. |
| `delete_music_audio` | Delete owned saved bytes/metadata only on an explicit user request. |
| `compare_music` | Two independent billable listens with the same rubric, then ChatGPT synthesizes the comparison. |

File parameters declare all four native properties: `download_url` and `file_id` are required; `mime_type` and `file_name` are declared but optional. Never fabricate a ChatGPT file ID for generated audio: use the returned service `audioId` instead.

## Model routing

| Intent | Default Replicate model |
| --- | --- |
| New instrumental/BGM | `fishaudio/ace-step-1.5` |
| New vocal song (`instrumental=false`) | `minimax/music-2.6` |
| Explicit whole-song cover | `minimax/music-cover` |
| Melody reference / continuation | `meta/musicgen` (pinned original version) |
| Listening | `lucataco/qwen2.5-omni-7b` |

`generationMode` is `auto | generate | cover | reference | continue`. An explicit `model` overrides model selection, not validation. Auto with a source defaults to melody reference, not cover merely because vocals were requested. Cover must reflect the user's actual intent and source compatibility.

The ACE-Step and MiniMax 2.6 Replicate deployments do **not** expose reference audio. Cover uses `audio_url`, never `bitrate` or `prompt`. Discovery no longer infers file inputs from prose descriptions.

Generation accepts `lyrics`, `instrumental`, `autoLyrics`, `seed`, `audioFormat`, optional `duration`, `sourceAudioId` or native `referenceAudio`. All creative requirements must already be compiled into `directorPrompt` (ACE-Step: 512 characters; MiniMax: 2000). The raw conversation summary is not appended to exceed that budget. Overlong prompts/lyrics and incompatible inputs fail instead of being silently truncated. Models without a duration field return a warning that the requested duration was not applied.

`get_service_status` reports defaults actually used. Node environment variables can override defaults; the current Sites Worker uses compiled defaults or explicit per-call model selection. Merely setting a Sites environment variable does not currently override the module's model defaults.

## Reusable workflow

1. Call `generate_music` with a stable `requestKey` for this operation.
2. Save `jobId`. Poll `get_music_job` using `pollAfterSeconds` until a terminal state.
3. A completed generation returns `audioId`/`audioIds`, model version and effective prompt.
4. Call `analyze_music(audioId, question)` directly. No download/re-upload to ChatGPT.
5. Call another generation with `sourceAudioId`; the result records its parent audio ID.

A repeated request key with the same input reuses the existing job; changed inputs with the same key are rejected. At most three active/unreconciled jobs are accepted per user. An ambiguous network failure during submission returns `submission_unknown`: reconcile the provider outcome instead of blindly submitting again. This is not a claim of exactly-once behavior across an external API/database failure.

Completed audio import is retryable via `storage_pending`; polling retries storage, not generation. Remote predictions receive a ten-minute cancellation deadline. HTTP wait timeouts are separate from cancellation confirmation.

## Audio storage and retention

Sites jobs and metadata use D1 table `music_records`; credentials remain in the existing separately encrypted `replicate_connections` table. All lookups, request keys and parent IDs are user-scoped. Optimistic record revisions protect concurrent updates.

The Worker accepts an optional R2-compatible binding named **`AUDIO_BUCKET`**. With it, completed audio bytes are stored under user-scoped opaque object keys. Without it, the API explicitly returns `storage: temporary` and keeps only the provider/source URL, not a durable copy.

**This branch does not provision object storage automatically.** Existing `.openai/hosting.json` keeps the original project ID/D1 binding and `r2: null`. Configure the appropriate platform-managed bucket/binding before claiming cloud audio persistence. `get_service_status.durableAudio` is the runtime truth. The local test harness uses a real filesystem object store.

Replicate API outputs are normally retained for one hour. This version imports outputs when the completed job is polled; it does not install a background webhook or scheduled sweeper. Poll completed jobs before provider retention expires. Unattended completion capture, storage quotas/retention schedules and automated submission reconciliation are follow-up work, not implemented promises.

Authenticated `GET /audio/{audioId}` serves saved audio through the Sites identity boundary. It is not a public shared link. Explicit deletion removes the service copy, not the original ChatGPT attachment or Replicate prediction.

## Listening and comparison boundaries

`startSec`/`endSec` perform real sample-aligned slicing for **PCM or IEEE-float WAV**. The supplied range is validated against file length and returned as `analyzedRange`.

Full MP3 and other provider-supported audio still work for whole-file listening. Compressed MP3/M4A segment requests currently fail clearly and request conversion to WAV; they never silently analyze the whole song. Request `audioFormat: wav` when generating material for a subsequent segment test.

Structured analysis is validated as `summary`, `observations`, `uncertainties`, and `suggestions`. Non-JSON model responses remain available as the raw `answer` with `structuredStatus: unavailable`; the server does not invent missing observations or confidence scores.

`compare_music` submits two independent analyses. Its output is not a joint raw-audio comparison model result, and partial failures must be reported before drawing conclusions. It incurs two inference requests.

## Registration/schema sanity check

The v0.7.1 manifest is a cache-busting registration revision. A correctly refreshed ChatGPT tool catalog must expose `get_service_status`, `get_music_job`, `register_music_audio`, `compare_music` and the other workflow tools. Its `generate_music` schema accepts a requested duration up to 600 seconds and advertises ACE-Step 1.5 / MiniMax Music 2.6 routing. If ChatGPT still shows only four tools, a default 8-second duration, or a 30-second maximum, it is using the legacy v0.4 registration rather than this build.

`npm run check:mcp -- <endpoint>` now fails if the published `generate_music` schema regresses to the old 30-second contract.

## Sites upgrade

Keep the same Sites project and `AUTH_ENCRYPTION_KEY`; do not create a replacement site or overwrite the original credential migration. Apply the new migration `drizzle/0001_mute_quentin_quire.sql` using the platform migration mechanism before serving workflow calls. The generated Drizzle snapshot and journal are checked in. Migration 0000 is unchanged.

```powershell
npm ci
npm run typecheck
npm test
```

`npm run build` builds Node and a browser-only Worker at `dist/server/index.js`. The Worker build includes the source Git SHA. Use the existing desktop Sites deployment workflow to publish the build, then verify `get_service_status` and `tools/list`. Updating GitHub alone does not update the live Sites runtime or the current conversation's tool catalog.

The Worker trusts `oai-authenticated-user-id` **only behind the Sites authentication gateway**. Never expose the Worker directly with a caller-controlled identity header. Existing per-user token encryption and connection form origin checks are retained. Audio downloads are bounded and reject local/numeric destinations; a production network egress policy is still needed for comprehensive SSRF/DNS-rebinding protection.

## Brook / local end-to-end debugging

Do not disturb an existing working checkout. Use an independent Git worktree. After installing/building:

```powershell
# Real compiled Sites Worker + local SQLite/object storage, loopback only.
node scripts/debug-site.mjs
```

Open `http://127.0.0.1:8797/connect` and connect Replicate **privately on that page**. The cloud connection is not copied into local tests. Never paste a token into chat or commit `.env`, encryption keys, databases or reports. The harness rejects foreign Host/Origin values and must never be published as a public gateway.

In another terminal:

```powershell
# No billable predictions: schema discovery, deployment metadata and connection.
node scripts/live-workflow.mjs

# Explicitly billable: one 10-second WAV generation and one 0-4s listening test.
node scripts/live-workflow.mjs --billable
```

The real test uses MCP SDK calls, stable request keys, polling, audioId reuse and a duplicate-submit assertion. It resumes from `.data/live-workflow-report.json` instead of blindly repeating generation. Override `MCP_URL`, `MUSIC_LIVE_REPORT`, `MUSIC_DEBUG_PORT` or `MUSIC_DEBUG_DIR` as needed. Do not point the debug harness at a public interface.

Automated `npm test` exercises the **actual Sites bundle**, real SQLite/filesystem storage, OAuth regressions, ownership isolation, retries, genuine WAV cropping and model mappings with mocked external HTTP. Passing those tests does not by itself prove live Replicate inference or ChatGPT desktop UI behavior; record live-test results separately.

## Source layout

```text
src/music-server.ts          shared MCP tools
src/music-workflow.ts        persistent prediction workflow
src/workflow-store.ts        user-owned job/audio records
src/audio.ts                 bounded download + WAV slicing
src/providers/replicate.ts   validated model plans and provider operations
src/replicate-transport.ts   HTTP and remote prediction deadlines
src/worker.ts                Sites authenticated entry
src/sites-store.ts           existing encrypted credential store
src/server.ts               Node OAuth entry
src/node-workflow.ts        local SQLite/filesystem adapters
scripts/debug-site.mjs       loopback Sites harness
scripts/live-workflow.mjs    resumable opt-in live test
```
