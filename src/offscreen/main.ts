interface OffscreenAudioMessage {
  target?: string;
  type?: string;
  requestId?: string;
  audioDataUrl?: string;
  playbackRate?: number;
}

interface AudioActionResponse {
  ok: boolean;
  message?: string;
}

let currentAudio: HTMLAudioElement | null = null;
let currentRequestId = "";
let lastAudioDataUrl = "";
let lastRequestId = "";
let lastPlaybackRate = 1;

function stopCurrentAudio(): void {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.removeAttribute("src");
    currentAudio.load();
  }
  currentAudio = null;
  currentRequestId = "";
}

function clearReplayCache(requestId?: string): void {
  if (requestId && requestId !== lastRequestId) return;
  lastAudioDataUrl = "";
  lastRequestId = "";
  lastPlaybackRate = 1;
}

function playAudio(audioDataUrl: string, requestId: string, playbackRate = 1): void {
  stopCurrentAudio();
  const normalizedRate = Number.isFinite(playbackRate)
    ? Math.min(2, Math.max(0.5, playbackRate))
    : 1;
  lastAudioDataUrl = audioDataUrl;
  lastRequestId = requestId;
  lastPlaybackRate = normalizedRate;
  const audio = new Audio(audioDataUrl);
  audio.playbackRate = normalizedRate;
  audio.preservesPitch = true;
  currentAudio = audio;
  currentRequestId = requestId;
  const clearIfCurrent = () => {
    if (currentAudio !== audio) return;
    currentAudio = null;
    currentRequestId = "";
  };
  audio.addEventListener("ended", clearIfCurrent, { once: true });
  audio.addEventListener("error", clearIfCurrent, { once: true });
  void audio.play().catch(clearIfCurrent);
}

chrome.runtime.onMessage.addListener((
  message: OffscreenAudioMessage,
  _sender,
  sendResponse: (response: AudioActionResponse) => void
) => {
  if (!message || message.target !== "offscreen-audio") return false;

  if (message.type === "STOP_AUDIO") {
    if (!message.requestId || message.requestId === currentRequestId || message.requestId === lastRequestId) {
      stopCurrentAudio();
      clearReplayCache(message.requestId);
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "REPLAY_AUDIO") {
    if (!message.requestId || message.requestId !== lastRequestId || !lastAudioDataUrl) {
      sendResponse({ ok: false, message: "当前语音解释已不可重听。" });
      return false;
    }
    playAudio(lastAudioDataUrl, lastRequestId, lastPlaybackRate);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "PLAY_AUDIO" && typeof message.audioDataUrl === "string") {
    playAudio(
      message.audioDataUrl,
      typeof message.requestId === "string" ? message.requestId : "",
      typeof message.playbackRate === "number" ? message.playbackRate : 1
    );
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
