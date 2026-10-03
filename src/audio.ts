export const MAX_AUDIO_BYTES = 50 * 1024 * 1024;

export function publicAudioUrl(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    throw new Error("Audio downloads require a public HTTPS URL without credentials.");
  }
  // Block numeric/local destinations before every redirect. Production deployments
  // should additionally use an outbound-network policy to prevent DNS rebinding.
  if (!host.includes(".") || host === "localhost" || /\.(localhost|local|internal)$/.test(host) || host.includes(":") || /^[\d.]+$/.test(host)) {
    throw new Error("Local and numeric audio download destinations are not allowed.");
  }
  return url;
}

export async function downloadAudio(url: string, name = "audio", mime = "audio/mpeg"): Promise<File> {
  let next = publicAudioUrl(url);
  const signal = AbortSignal.timeout(60000);
  for (let hop = 0; hop <= 3; hop++) {
    const response = await fetch(next, { redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("Audio redirect is missing its destination.");
      next = publicAudioUrl(new URL(location, next).href);
      continue;
    }
    if (!response.ok) throw new Error(`Audio download failed (HTTP ${response.status}); the attachment may have expired.`);
    if (Number(response.headers.get("content-length")) > MAX_AUDIO_BYTES) {
      await response.body?.cancel();
      throw new Error("Audio exceeds the 50 MB limit.");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty audio response.");
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_AUDIO_BYTES) { await reader.cancel(); throw new Error("Audio exceeds the 50 MB limit."); }
        parts.push(value);
      }
    } finally { reader.releaseLock(); }
    if (!size) throw new Error("Audio file is empty.");
    const contentType = response.headers.get("content-type")?.split(";")[0];
    if (contentType && /^(text\/|application\/(json|xml))/.test(contentType)) throw new Error("The audio URL returned a document instead of audio.");
    return new File(parts as BlobPart[], name.split(/[\\/]/).pop() || "audio", { type: contentType?.startsWith("audio/") ? contentType : mime });
  }
  throw new Error("Too many audio redirects.");
}

// PCM/IEEE-float WAV can be sliced in a Worker without FFmpeg or an extra model call.
// Compressed formats deliberately fail rather than silently analyzing the full song.
export async function sliceWav(file: File, startSec: number, endSec: number): Promise<File> {
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec < 0 || endSec <= startSec) throw new Error("Invalid audio range.");
  const data = await file.arrayBuffer();
  const view = new DataView(data);
  const text = (offset: number, length: number) => new TextDecoder().decode(new Uint8Array(data, offset, length));
  if (data.byteLength < 44 || text(0, 4) !== "RIFF" || text(8, 4) !== "WAVE") throw new Error("Segment analysis currently requires PCM WAV. Convert the source to WAV; no full-track fallback was performed.");
  let format: Uint8Array | undefined;
  let pcm: Uint8Array | undefined;
  for (let offset = 12; offset + 8 <= data.byteLength;) {
    const size = view.getUint32(offset + 4, true);
    if (offset + 8 + size > data.byteLength) throw new Error("Malformed WAV chunk.");
    const id = text(offset, 4);
    if (id === "fmt ") format = new Uint8Array(data, offset + 8, size);
    if (id === "data") pcm = new Uint8Array(data, offset + 8, size);
    offset += 8 + size + (size % 2);
  }
  if (!format || format.byteLength < 16 || !pcm) throw new Error("WAV format/data chunks are missing.");
  const fmt = new DataView(format.buffer, format.byteOffset, format.byteLength);
  const encoding = fmt.getUint16(0, true), rate = fmt.getUint32(4, true), block = fmt.getUint16(12, true);
  if (![1, 3].includes(encoding) || !rate || !block) throw new Error("Only PCM and IEEE-float WAV are supported for slicing.");
  const duration = pcm.byteLength / block / rate;
  if (endSec > duration + 1 / rate) throw new Error(`Selected range exceeds audio duration (${duration.toFixed(3)} seconds).`);
  const start = Math.floor(startSec * rate) * block, end = Math.min(pcm.byteLength, Math.floor(endSec * rate) * block);
  if (end <= start) throw new Error("Selected range contains no samples.");
  const fpad = format.byteLength % 2, length = end - start, dpad = length % 2;
  const output = new Uint8Array(12 + 8 + format.byteLength + fpad + 8 + length + dpad);
  const out = new DataView(output.buffer);
  const put = (offset: number, value: string) => output.set(new TextEncoder().encode(value), offset);
  put(0, "RIFF"); out.setUint32(4, output.byteLength - 8, true); put(8, "WAVE"); put(12, "fmt ");
  out.setUint32(16, format.byteLength, true); output.set(format, 20);
  const at = 20 + format.byteLength + fpad;
  put(at, "data"); out.setUint32(at + 4, length, true); output.set(pcm.subarray(start, end), at + 8);
  return new File([output], "segment.wav", { type: "audio/wav" });
}
