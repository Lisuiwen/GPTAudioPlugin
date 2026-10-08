# GPTAudioMCP 0.9.0

GPTAudioMCP is a Site-hosted MCP service for music generation and source-audio editing with Runware ACE-Step 1.5. The Site manages one Runware API key. Users do not enter a personal provider token.

## What it does

| Request | Implementation |
| --- | --- |
| New music | Runware ACE-Step 1.5 XL Turbo by default |
| Cover, reference, repaint or continuation | Runware ACE-Step 1.5 XL Turbo |
| Higher-quality, slower edit | Runware ACE-Step 1.5 XL Base |
| Listen to or compare finished songs | Temporarily unavailable |

Runware accepts 30–300 seconds for new generation. Source-audio requests do not accept duration; repaintingStart and repaintingEnd specify the edited or extended range. Runware does not provide server-side cancellation for an in-flight audio task. Stopping a client wait does not stop billing.

## MCP tools

| Tool | Purpose |
| --- | --- |
| get_service_status | Read version, build SHA, Runware configuration and storage status. |
| inspect_music_model | Read hosted model capabilities without inference. |
| generate_music | Generate or edit music; this is billable. |
| get_music_job | Check or reconcile a submitted job without regenerating. |
| cancel_music_job | Read a finished result or report Runware's cancellation limit. |
| register_music_audio | Register an attachment for reuse by audioId. |
| get_music_audio | Read owner-scoped audio metadata. |
| delete_music_audio | Delete an owner-scoped audio record and stored bytes. |

New generation uses the deployment secret RUNWARE_API_KEY. The default model is runware:ace-step@v1.5-xl-turbo; runware:ace-step@v1.5-xl-base is available for slower, higher-quality edits. No user-facing connection or token form is exposed. The old /connect URL shows the read-only service page.

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
