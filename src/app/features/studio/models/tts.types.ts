/**
 * TTS Settings interface - moved from deprecated tts-settings component
 */
export interface TTSSettings {
  device: 'gpu' | 'mps' | 'cpu';
  language: string;
  ttsEngine: string;        // e.g., 'xtts'
  fineTuned: string;        // voice model e.g., 'ScarlettJohansson'
  temperature: number;
  topP: number;
  topK: number;
  repetitionPenalty: number;
  speed: number;
  enableTextSplitting: boolean;
  // Parallel processing options
  useParallel?: boolean;
  parallelWorkers?: number;
  parallelMode?: 'sentences' | 'chapters'; // 'sentences' = fine-grained, 'chapters' = natural boundaries
}

export interface HardwareInfo {
  recommendedWorkers: number;
  reason: string;
}

export interface VoiceOption {
  id: string;
  name: string;
  language: string;
  description?: string;
}
