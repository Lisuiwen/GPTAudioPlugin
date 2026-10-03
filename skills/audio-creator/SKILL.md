---
name: audio-creator
description: Generate, reference, cover or continue music through Replicate; reuse audioIds and recover existing jobs without duplicate paid submissions.
---

# Audio Creator

Stay in the current conversation. No separate text-model API or recording panel is required.

Check `get_service_status` when the deployed build or tool catalog is uncertain. Read actual model limits through `inspect_music_model`; never infer capabilities from the model name or a README.

Compile the user's creative context into `directorPrompt`, preserving instrumentation, mood, scene, structure, vocal preference and repetition/looping requirements. Keep `conversationSummary` as explanatory context; the service does not append it beyond the model prompt budget. ACE-Step accepts 512 characters; current MiniMax adapters accept 2000. Rewrite overlong prompts deliberately rather than silently dropping constraints. Do not truncate supplied lyrics.

Select the operation explicitly when intent is clear:
- `generate`: new music with no source. Default instrumental is ACE-Step; vocal requests route to MiniMax 2.6.
- `reference`: melody-conditioned new music using a source, currently MusicGen.
- `continue`: extend the source, currently MusicGen.
- `cover`: whole-song re-arrangement with compatible source material, currently MiniMax Cover. It is not local inpainting and does not guarantee instrumental-only output.

Use `sourceAudioId` for a previously returned service asset, or `referenceAudio` for the native ChatGPT attachment. Never fabricate an attachment file_id for a generated URL, silently ignore source audio, or switch reference/cover/continue semantics just to make a request succeed.

Set `instrumental`, optional `lyrics`, `autoLyrics`, `duration`, `seed`, and `audioFormat` only according to the user's request and model support. Request WAV when subsequent sample-based segment analysis is planned. Do not promise exact duration when the model has no duration parameter, or a seamless loop without checking it.

Use one stable `requestKey` per creative operation. A transport retry must reuse that key. A new version gets a new key. Record the returned `jobId` and poll `get_music_job` according to `pollAfterSeconds`. Queued/processing is not completion. `storage_pending` means retry importing the same result, not regenerate. `submission_unknown` requires reconciliation; never blindly create another paid prediction. Cancellation is not proof of zero charges.

On completion retain `audioId`, `audioIds`, model/version, effective prompt and warnings. Use those IDs directly for listening or later versions; do not make the user upload the generated file again. Poll completed jobs promptly: output import happens on polling, not through a background webhook. If storage is temporary, disclose the expiry instead of promising future reuse.

Protected operations use the connected Replicate account. Tokens belong only on the account connection page, never in conversation, code, logs or source control. Generation is billable. Respect explicit deletion/cancellation intent.
