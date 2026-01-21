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

/**
 * Pre-defined voice models
 */
export const AVAILABLE_VOICES: VoiceModel[] = [
  { id: 'ScarlettJohansson', name: 'Scarlett Johansson', description: 'Female, warm and natural' },
  { id: 'DavidAttenborough', name: 'David Attenborough', description: 'Male, documentary narrator' },
  { id: 'MorganFreeman', name: 'Morgan Freeman', description: 'Male, deep and resonant' },
  { id: 'NeilGaiman', name: 'Neil Gaiman', description: 'Male, storyteller' },
  { id: 'RayPorter', name: 'Ray Porter', description: 'Male, audiobook narrator' },
  { id: 'RosamundPike', name: 'Rosamund Pike', description: 'Female, British accent' },
];

/**
 * Speed presets
 */
export const SPEED_OPTIONS = [
  { value: 0.75, label: '0.75x' },
  { value: 1.0, label: '1.0x' },
  { value: 1.25, label: '1.25x' },
  { value: 1.5, label: '1.5x' },
];
