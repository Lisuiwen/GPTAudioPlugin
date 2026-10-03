# v0.7 validation — 2026-10-03

## Tested environment

- Machine: Brook, Windows; separate `GPTAudioPlugin-workflow-v07` worktree.
- Node 22.21.1; npm 10.9.4.
- Runtime source commit: `9f4ff326cf4e8de87327cb120820cb77492d8906`.
- The actual compiled Sites Worker was executed behind the loopback-only debug harness, with real SQLite and filesystem object storage.
- The existing original checkout, main branch and deployed Sites service were not overwritten.

## Automated verification

`npm run typecheck`, Node build, Sites browser bundle build and `npm test` passed on Brook. **30 tests passed, zero failures.** The GitHub `ci` workflow also passed for the tested runtime commit (run 37112944859).

Automated tests use mocked provider HTTP, not paid inference. They cover exact model field detection, file parameter schema, additive database migration, user isolation, request-key conflicts, concurrent duplicate submission, per-user active-job limit, network-loss submission uncertainty, retryable output import, real WAV sample cropping, structured-response validation, cancellation state and independent A/B analysis submissions.

Fault injection exposed an SDK behavior: thrown network errors during prediction creation caused repeated POST attempts. The transport now converts an ambiguous creation failure to a non-retryable local response; the regression verifies a single creation attempt and a persisted `submission_unknown` result.

## Real Replicate schema checks

Executed through the local MCP endpoint using the connected account; these queries did not create predictions.

| Replicate model | Verified audio field |
| --- | --- |
| `fishaudio/ace-step-1.5` | None; `supportsAudioInput=false` |
| `minimax/music-2.6` | None; `supportsAudioInput=false` |
| `minimax/music-cover` | `audio_url` |
| `meta/musicgen` | `input_audio` |
| `lucataco/qwen2.5-omni-7b` | `audio` |

All five assertions passed. Prompts and bitrates were not misclassified as audio inputs.

## Real billable end-to-end run

Executed `node scripts/live-workflow.mjs --billable` against the actual local Sites harness after the user connected Replicate privately on its connection page.

1. `generate_music` submitted a 10-second instrumental WAV request to `fishaudio/ace-step-1.5`.
2. The asynchronous job progressed through starting/processing to succeeded.
3. Its output was saved to local object storage and registered as a reusable `audioId`.
4. Repeating the same generation request with the same requestKey returned the original job, not another generation.
5. `analyze_music` reused that audioId, actually cropped **0–4 seconds** of the WAV and submitted the resulting audio to `lucataco/qwen2.5-omni-7b`.
6. Listening completed successfully. `structuredStatus` was **validated**, with summary, observations, uncertainties and suggestions. `analyzedRange` matched `{startSec:0,endSec:4}`.
7. The local MCP server was restarted. Running the same live regression again reused both original completed jobs and the same audioId. The persisted store still contained **two jobs**, one generation and one analysis, both succeeded.

The initial live regression process completed successfully in approximately 177 seconds, including model startup and polling. This single run is not a latency benchmark or evidence of musical-quality accuracy. The test validates data flow and returned structure, not every musical claim made by the listening model.

The private machine report is `.data/live-workflow-report.json`. Actual prediction IDs, audio download URLs, connection identities, tokens, encryption keys and databases are not committed here.

## Boundaries not covered by the live run

- MiniMax generation/Cover, cancellation and A/B comparison were not additionally invoked as paid tests. Their mappings and behavior have schema/mock coverage as noted above.
- No new Sites production deployment or ChatGPT desktop UI scan was performed. An MCP client's successful discovery is not proof of the desktop app's final catalog state.
- Cloud D1 migration 0001 must be applied before publishing the workflow upgrade.
- Cloud `AUDIO_BUCKET` provisioning is not performed by this branch. Without it, the Worker explicitly reports temporary audio references. Durable bytes were tested using the local filesystem adapter.
- Completed outputs are imported when polled; there is no autonomous webhook/sweeper yet.
- Actual segment cropping supports PCM/IEEE-float WAV. Compressed MP3/M4A segment cropping is not implemented; full-file listening remains available.
- A/B comparison means two independent listens with the same rubric, not joint raw-audio comparative reasoning.
