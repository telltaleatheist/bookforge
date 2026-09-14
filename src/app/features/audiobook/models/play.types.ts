/**
 * Play Tab Types
 *
 * TypeScript interfaces for the real-time TTS playback feature.
 */

/**
 * A single sentence parsed from chapter text
 */
export interface PlayableSentence {
  index: number;
  text: string;
  charStart: number;  // Position in chapter text
  charEnd: number;
}

/**
 * A chapter with its parsed sentences
 */
export interface PlayableChapter {
  id: string;
  title: string;
  text: string;
  sentences: PlayableSentence[];
}

/**
 * Settings for TTS playback
 */
export interface PlaySettings {
  voice: string;
  speed: number;
  temperature?: number;
  topP?: number;
  repetitionPenalty?: number;
}

/**
 * Audio chunk received from TTS engine
 */
export interface AudioChunk {
  data: string;  // Base64 WAV
  duration: number;
  sampleRate: number;
}

/**
 * Playback state
 */
export type PlaybackState = 'idle' | 'loading' | 'playing' | 'paused' | 'buffering';

/**
 * Session state
 */
export type SessionState = 'inactive' | 'starting' | 'ready' | 'error';

/**
 * Available voice model
 */
export interface VoiceModel {
  id: string;
  name: string;
  description?: string;
}

/*
 * `AVAILABLE_VOICES` IS DELETED (2026-09-14, audit section 5).
 *
 * It was the XTTS roster — six celebrity-named preset ids that shipped with
 * `xtts-v2/eng/<Name>/` and left the build with the engine on 2026-09-05. It
 * had ONE occurrence in the whole of src/: its own declaration. Nothing
 * imported it, because the voice list a player draws comes from
 * `playGetVoices()`, which asks the engine that is actually running.
 *
 * {@link VoiceModel} above stays: it is the shape that answer arrives in.
 */

/**
 * Speed presets
 */
export const SPEED_OPTIONS = [
  { value: 0.75, label: '0.75x' },
  { value: 1.0, label: '1.0x' },
  { value: 1.25, label: '1.25x' },
  { value: 1.5, label: '1.5x' },
];
