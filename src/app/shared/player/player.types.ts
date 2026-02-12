/**
 * Shared Player Types
 *
 * Common interfaces used by both the audiobook player and bilingual player.
 */

export interface PlayerChapter {
  id: string;
  title: string;
  order: number;
  startTime: number;       // seconds
  endTime: number;         // seconds
  startCueIndex: number;   // first VTT cue in this chapter
  endCueIndex: number;     // last VTT cue in this chapter
}

export interface BookmarkState {
  position: number;        // currentTime in seconds
  chapterId?: string;
  cueIndex?: number;
  lastPlayedAt: string;    // ISO timestamp
  speed?: number;          // playback speed (mono player)
  sourceSpeed?: number;    // source language speed (bilingual)
  targetSpeed?: number;    // target language speed (bilingual)
}

export type TransportAction = 'play' | 'pause' | 'previous' | 'next';

export interface SeekEvent {
  time: number;
}

export interface ChapterSelectEvent {
  chapter: PlayerChapter;
}
