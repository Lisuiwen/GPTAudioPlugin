# GPTAudioMCP 0.10.0

GPTAudioMCP is a Site-hosted MCP service for music generation and source-audio editing with Runware ACE-Step 1.5, plus listening critique through Runware Gemini 3.8 Flash. The Site manages one Runware API key. Users do not enter a personal provider token.

## What it does

| Request | Implementation |
| --- | --- |
| New music | Runware ACE-Step 1.5 XL Turbo by default |
| Cover, reference, repaint or continuation | Runware ACE-Step 1.5 XL Turbo |
| Higher-quality, slower edit | Runware ACE-Step 1.5 XL Base |
| Listen to a finished song | Runware Gemini 3.8 Flash |
| Compare two finished songs | Two independent Gemini 3.8 Flash listens with the same rubric |

Runware accepts 30–300 seconds for new generation. Source-audio requests do not accept duration; repaintingStart and repaintingEnd specify the edited or extended range. Runware does not provide server-side cancellation for an in-flight audio task. Stopping a client wait does not stop billing.

## MCP tools

| Tool | Purpose |
| --- | --- |
| get_service_status | Read version, build SHA, Runware configuration and storage status. |
| inspect_music_model | Read hosted model capabilities without inference. |
| generate_music | Generate or edit music; this is billable. |
| analyze_music | Listen to an attachment or saved audioId; this is billable. |
| compare_music | Analyze two saved audioIds with the same rubric; this makes two billable calls. |
| get_music_job | Read a submitted job; ACE-Step generation can be reconciled by task UUID. |
| cancel_music_job | Read a finished result or report Runware's cancellation limit. |
| register_music_audio | Register an attachment for reuse by audioId. |
| get_music_audio | Read owner-scoped audio metadata. |
| delete_music_audio | Delete an owner-scoped audio record and stored bytes. |

Generation and listening use the deployment secret RUNWARE_API_KEY. The default music model is runware:ace-step@v1.5-xl-turbo; runware:ace-step@v1.5-xl-base is available for slower, higher-quality edits. Listening uses google:gemini@3.8-flash through Runware's OpenAI-compatible endpoint. No user-facing connection or token form is exposed. The old /connect URL shows the read-only service page.

Listening accepts WAV or MP3 up to 20 MB. startSec/endSec really crops PCM or IEEE-float WAV; compressed segments fail before inference. The compatible listening endpoint has no task UUID polling. A repeated requestKey returns its saved job, and an ambiguous submission is marked submission_unknown instead of automatically submitted again. Compare submits two independent listening calls and reports both jobs.

## Deployment

The existing Site is identified by .openai/hosting.json. Preserve its project_id and D1 binding DB when publishing changes. Add RUNWARE_API_KEY as a Site secret. The existing AUTH_ENCRYPTION_KEY may remain configured but is no longer read by the application.

The D1 music_records table stores user-owned jobs and audio metadata. The historical replicate_connections table remains in existing databases and migration history so deployment does not destroy previously stored data; production code no longer reads or writes it. A deliberate data-retention decision is required before deleting historical rows.

An optional AUDIO_BUCKET binding stores durable audio bytes. Without it, the service reports temporary storage and retains provider or source URLs. Runware output URLs normally remain available for seven days. get_service_status.durableAudio is the runtime check.

## Local development

    npm ci
    npm run typecheck
    npm run build
    npm run dev

The development server binds to 127.0.0.1 and uses a local identity. Production identity is provided by the Sites gateway. Set RUNWARE_API_KEY in the local environment only when testing billable generation. Never commit provider secrets.

The non-billable MCP catalog check is:

    npm run check:mcp -- http://127.0.0.1:8787/mcp

The Site Worker bundle is written to dist/server/index.js by npm run build:site. Its deployment manifest is copied to dist/.openai/hosting.json.
