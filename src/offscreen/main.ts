interface OffscreenAudioMessage {
  target?: string;
  type?: string;
  requestId?: string;
  audioBase64?: string;
  playbackRate?: number;
}

interface AudioActionResponse {
  ok: boolean;
  message?: string;
  started?: boolean;
  replayable?: boolean;
}

const PCM_SAMPLE_RATE = 24000;
const START_BUFFER_SECONDS = 0.03;
const MAX_REPLAY_AUDIO_BYTES = 8 * 1024 * 1024;

let audioContext: AudioContext | null = null;
let currentRequestId = "";
let currentPlaybackRate = 1;
let nextStartTime = 0;
let firstChunkScheduled = false;
let streamComplete = false;
let replayRequestId = "";
let replayPlaybackRate = 1;
let replayChunks: string[] = [];
let replayBytes = 0;
let replayCacheOverflow = false;
const activeSources = new Set<AudioBufferSourceNode>();

function normalizedRate(value: number | undefined): number {
  return Number.isFinite(value) ? Math.min(2, Math.max(0.5, value!)) : 1;
}

async function ensureAudioContext(): Promise<AudioContext> {
  if (!audioContext || audioContext.state === "closed") {
    audioContext = new AudioContext({ sampleRate: PCM_SAMPLE_RATE });
  }
  if (audioContext.state === "suspended") await audioContext.resume();
  return audioContext;
}

function stopSources(): void {
  for (const source of activeSources) {
    try { source.stop(); } catch { /* already stopped */ }
  }
  activeSources.clear();
  currentRequestId = "";
  nextStartTime = 0;
  firstChunkScheduled = false;
}

function clearReplayCache(requestId?: string): void {
  if (requestId && requestId !== replayRequestId) return;
  replayRequestId = "";
  replayPlaybackRate = 1;
  replayChunks = [];
  replayBytes = 0;
  replayCacheOverflow = false;
  streamComplete = false;
}

function estimateBase64Bytes(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(value.length * 3 / 4) - padding);
}

function decodePcm16(audioBase64: string): Float32Array {
  const binary = atob(audioBase64);
  const sampleCount = Math.floor(binary.length / 2);
  const pcm = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    const low = binary.charCodeAt(index * 2);
    const high = binary.charCodeAt(index * 2 + 1);
    let sample = (high << 8) | low;
    if (sample >= 0x8000) sample -= 0x10000;
    pcm[index] = sample / 32768;
  }
  return pcm;
}

async function queuePcmChunk(
  audioBase64: string,
  requestId: string,
  playbackRate: number,
  cacheForReplay: boolean
): Promise<boolean> {
  const context = await ensureAudioContext();
  if (requestId !== currentRequestId) throw new Error("语音流已经被新的请求替换。");

  const pcm = decodePcm16(audioBase64);
  if (pcm.length === 0) return false;
  const buffer = context.createBuffer(1, pcm.length, PCM_SAMPLE_RATE);
  buffer.getChannelData(0).set(pcm);

  const source = context.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = playbackRate;
  source.connect(context.destination);
  activeSources.add(source);
  source.addEventListener("ended", () => activeSources.delete(source), { once: true });

  const now = context.currentTime;
  const startAt = firstChunkScheduled
    ? Math.max(nextStartTime, now + 0.005)
    : now + START_BUFFER_SECONDS;
  source.start(startAt);
  nextStartTime = startAt + buffer.duration / playbackRate;

  if (cacheForReplay && !replayCacheOverflow) {
    const chunkBytes = estimateBase64Bytes(audioBase64);
    if (replayBytes + chunkBytes <= MAX_REPLAY_AUDIO_BYTES) {
      replayChunks.push(audioBase64);
      replayBytes += chunkBytes;
    } else {
      replayChunks = [];
      replayBytes = 0;
      replayCacheOverflow = true;
    }
  }
  if (firstChunkScheduled) return false;

  firstChunkScheduled = true;
  const waitMs = Math.max(0, (startAt - context.currentTime) * 1000);
  if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
  return true;
}

async function replayCachedStream(requestId: string): Promise<void> {
  if (requestId !== replayRequestId || replayChunks.length === 0 || !streamComplete) {
    throw new Error("当前语音解释已不可重听。");
  }
  stopSources();
  currentRequestId = requestId;
  currentPlaybackRate = replayPlaybackRate;
  nextStartTime = 0;
  firstChunkScheduled = false;
  for (const chunk of replayChunks) {
    await queuePcmChunk(chunk, requestId, currentPlaybackRate, false);
  }
}

chrome.runtime.onMessage.addListener((
  message: OffscreenAudioMessage,
  _sender,
  sendResponse: (response: AudioActionResponse) => void
) => {
  if (!message || message.target !== "offscreen-audio") return false;

  if (message.type === "STOP_AUDIO") {
    if (!message.requestId || message.requestId === currentRequestId || message.requestId === replayRequestId) {
      stopSources();
      clearReplayCache(message.requestId);
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "STREAM_START" && typeof message.requestId === "string") {
    stopSources();
    clearReplayCache();
    currentRequestId = message.requestId;
    currentPlaybackRate = normalizedRate(message.playbackRate);
    replayRequestId = message.requestId;
    replayPlaybackRate = currentPlaybackRate;
    replayBytes = 0;
    replayCacheOverflow = false;
    streamComplete = false;
    void ensureAudioContext()
      .then(() => sendResponse({ ok: true }))
      .catch(error => sendResponse({
        ok: false,
        message: error instanceof Error ? error.message : "无法启动流式音频播放器。"
      }));
    return true;
  }

  if (message.type === "STREAM_CHUNK"
    && typeof message.requestId === "string"
    && typeof message.audioBase64 === "string") {
    void queuePcmChunk(message.audioBase64, message.requestId, currentPlaybackRate, true)
      .then(started => sendResponse({ ok: true, started }))
      .catch(error => sendResponse({
        ok: false,
        message: error instanceof Error ? error.message : "流式音频播放失败。"
      }));
    return true;
  }

  if (message.type === "STREAM_END" && typeof message.requestId === "string") {
    if (message.requestId === replayRequestId) {
      streamComplete = !replayCacheOverflow && replayChunks.length > 0;
    }
    sendResponse({ ok: true, replayable: streamComplete });
    return false;
  }

  if (message.type === "REPLAY_STREAM" && typeof message.requestId === "string") {
    void replayCachedStream(message.requestId)
      .then(() => sendResponse({ ok: true }))
      .catch(error => sendResponse({
        ok: false,
        message: error instanceof Error ? error.message : "重听语音解释失败。"
      }));
    return true;
  }

  return false;
});
