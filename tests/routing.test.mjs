import test from "node:test";
import assert from "node:assert/strict";

process.env.REPLICATE_MODEL = "";
process.env.REPLICATE_COVER_MODEL = "";
process.env.REPLICATE_VOCAL_MODEL = "";
process.env.REPLICATE_CONTINUATION_MODEL = "";

const { selectReplicateGenerationRoute } = await import("../dist/providers/replicate.js");

function request(overrides = {}) {
  return {
    conversationSummary: "game music context",
    directorPrompt: "light island summer BGM with ukulele",
    duration: 30,
    instrumental: true,
    autoLyrics: true,
    ...overrides,
  };
}

test("new music routes to ACE-Step", () => {
  assert.deepEqual(selectReplicateGenerationRoute(request()), {
    model: "fishaudio/ace-step-1.5",
    generationMode: "generate",
  });
});


test("new vocal music routes to MiniMax Music 2.6", () => {
  assert.deepEqual(
    selectReplicateGenerationRoute(
      request({
        instrumental: false,
      })
    ),
    {
      model: "minimax/music-2.6",
      generationMode: "generate",
    }
  );
});

test("vocal reference routes to MiniMax Music Cover", () => {
  assert.deepEqual(
    selectReplicateGenerationRoute(
      request({
        instrumental: false,
        referenceAudioUrl: "https://example.com/source.mp3",
      })
    ),
    {
      model: "minimax/music-cover",
      generationMode: "cover",
    }
  );
});

test("instrumental reference routes to MusicGen melody conditioning", () => {
  const route = selectReplicateGenerationRoute(
    request({
      instrumental: true,
      referenceAudioUrl: "https://example.com/source.mp3",
    })
  );
  assert.equal(route.generationMode, "reference");
  assert.match(route.model, /^meta\/musicgen:/);
});

test("continuation routes to MusicGen continuation", () => {
  const route = selectReplicateGenerationRoute(
    request({
      referenceAudioUrl: "https://example.com/source.mp3",
      continuation: true,
    })
  );
  assert.equal(route.generationMode, "continue");
  assert.match(route.model, /^meta\/musicgen:/);
});

test("explicit model overrides automatic routing", () => {
  assert.deepEqual(
    selectReplicateGenerationRoute(
      request({
        model: "minimax/music-2.6",
        referenceAudioUrl: "https://example.com/source.mp3",
      })
    ),
    {
      model: "minimax/music-2.6",
      generationMode: "custom",
    }
  );
});

test("cover mode requires reference audio", () => {
  assert.throws(
    () =>
      selectReplicateGenerationRoute(
        request({
          generationMode: "cover",
          referenceAudioUrl: undefined,
        })
      ),
    /requires a reference audio attachment/
  );
});
