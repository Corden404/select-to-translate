export interface PronunciationResult {
  phonetic?: string;
  audioDataUrl?: string;
  label?: string;
}

export interface PronunciationProvider {
  getPronunciation(word: string, signal?: AbortSignal): Promise<PronunciationResult>;
}
