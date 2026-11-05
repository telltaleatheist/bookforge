/**
 * The coverage guard: did the chunk say all the text, and only the text? A port of
 * `narrator/align/coverage.py`. A duration ratio cannot see this: a chunk measured 0.99 while
 * dropping 22% of its text. It is an AUDIT (Owen, 2026-09-05): assembly reports it and refuses nothing.
 */

import { pyFixed, pyFloat, pyRepr, pyRound } from '../py-compat';
import type { CoveragePolicy } from '../assemble/engine-profiles';
import { isTimed, SCORE_SOURCE, type Alignment, type AudioSpan, type TextSpan } from './aligner';

/** The version `assemble/coverage-gate.ts` reads. */
const REPORT_VERSION = 1;

export interface ChunkCoverage {
  readonly index: number;
  readonly wordsTotal: number;
  readonly wordsCredible: number;
  readonly alignedRatio: number;
  readonly droppedText: readonly TextSpan[];
  readonly insertedAudio: readonly AudioSpan[];
  readonly duration: number;
  readonly elapsed: number;
  readonly failed: boolean;
  readonly reasons: readonly string[];
}

const floatOrNull = (value: number | null): unknown => (value === null ? null : pyFloat(value));
const rounded = (value: number, digits: number): unknown => pyFloat(pyRound(value, digits));

function chunkDocument(c: ChunkCoverage): unknown {
  return {
    index: c.index,
    wordsTotal: c.wordsTotal,
    wordsCredible: c.wordsCredible,
    alignedRatio: rounded(c.alignedRatio, 4),
    durationSeconds: rounded(c.duration, 3),
    elapsedSeconds: rounded(c.elapsed, 3),
    failed: c.failed,
    reasons: c.reasons,
    scoreSource: SCORE_SOURCE,
    droppedText: c.droppedText.map((s) => ({
      firstWord: s.firstWord,
      lastWord: s.lastWord,
      words: s.words,
      text: s.text,
      audioStart: floatOrNull(s.audioStart),
      audioEnd: floatOrNull(s.audioEnd),
      worstScore: floatOrNull(s.worstScore),
    })),
    insertedAudio: c.insertedAudio.map((s) => ({
      start: rounded(s.start, 3),
      end: rounded(s.end, 3),
      seconds: rounded(s.end - s.start, 3),
      speechFraction: rounded(s.speechFraction, 3),
      where: s.where,
    })),
  };
}

/** One chunk's alignment, judged against one engine's policy. */
export function evaluateChunk(alignment: Alignment, policy: CoveragePolicy, index: number): ChunkCoverage {
  const { words } = alignment;
  const credible = words.filter((w) => isTimed(w) && w.score !== null && w.score >= policy.minWordScore).length;
  const ratio = words.length > 0 ? credible / words.length : 0;
  const dropped = alignment.unalignedTextSpans.filter((s) => s.words >= policy.droppedRunWords);
  const inserted = alignment.unalignedAudioSpans.filter(
    (s) => s.end - s.start >= policy.minInsertedAudioS && s.speechFraction > policy.maxInsertedSpeechFraction,
  );

  const reasons: string[] = [];
  const uncredible = words.length - credible;
  if (ratio < policy.minAlignedRatio && uncredible >= policy.minUncredibleWords) {
    reasons.push(`aligned ratio ${pyFixed(ratio, 3)} is below ${pyFixed(policy.minAlignedRatio, 2)} (${uncredible} of ${words.length} words not credible)`);
  }
  if (dropped.length > policy.maxDroppedSpans) {
    const worst = dropped.reduce((a, b) => (b.words > a.words ? b : a));
    reasons.push(`${dropped.length} dropped-text span(s), worst ${worst.words} word(s) from word ${worst.firstWord}: ${pyRepr([...worst.text].slice(0, 80).join(''))}`);
  }
  for (const span of inserted) {
    reasons.push(`${pyFixed(span.end - span.start, 2)}s of ${span.where} audio with no text at ${pyFixed(span.start, 2)}s (${pyFixed(span.speechFraction * 100, 0)}% speech)`);
  }
  return {
    index,
    wordsTotal: words.length,
    wordsCredible: credible,
    alignedRatio: ratio,
    droppedText: dropped,
    insertedAudio: inserted,
    duration: alignment.duration,
    elapsed: alignment.elapsed,
    failed: reasons.length > 0,
    reasons,
  };
}

export interface AlignError {
  readonly index: number;
  readonly stage: string;
  readonly error: string;
}

export interface SkippedChunk {
  readonly index: number;
  readonly reason: string;
  readonly text: string;
}

export interface CoverageDocumentInput {
  readonly engineId: string;
  readonly policy: CoveragePolicy;
  readonly backend: string;
  readonly language: string;
  readonly sessionId: string | null;
  readonly processDir: string;
  readonly chunksInManifest: number;
  readonly errors: readonly AlignError[];
  readonly skipped: readonly SkippedChunk[];
}

/** The report `coverage.json`. Numbers a Python float would print as `1.0` arrive here as {@link pyFloat}. */
export function coverageDocument(coverages: readonly ChunkCoverage[], input: CoverageDocumentInput): CoverageDocument {
  const { policy, errors, skipped } = input;
  const failed = coverages.filter((c) => c.failed);
  const ratios = coverages.map((c) => c.alignedRatio).sort((a, b) => a - b);
  const seconds = coverages.map((c) => c.elapsed).sort((a, b) => a - b);
  const middle = (values: readonly number[]): number => values[Math.floor(values.length / 2)];
  const any = coverages.length > 0;
  return {
    version: REPORT_VERSION,
    engine: input.engineId,
    backend: input.backend,
    scoreSource: SCORE_SOURCE,
    language: input.language,
    sessionId: input.sessionId,
    processDir: input.processDir,
    chunksInManifest: input.chunksInManifest,
    audited: policy.audited,
    policy: {
      minWordScore: pyFloat(policy.minWordScore),
      minAlignedRatio: pyFloat(policy.minAlignedRatio),
      minUncredibleWords: policy.minUncredibleWords,
      droppedRunWords: policy.droppedRunWords,
      maxDroppedSpans: policy.maxDroppedSpans,
      minInsertedAudioSeconds: pyFloat(policy.minInsertedAudioS),
      maxInsertedSpeechFraction: pyFloat(policy.maxInsertedSpeechFraction),
    },
    summary: {
      chunksAligned: coverages.length,
      chunksSkipped: skipped.length,
      chunksFailed: failed.length,
      failedIndices: failed.map((c) => c.index),
      alignedRatioMin: any ? pyFloat(pyRound(ratios[0], 4)) : null,
      alignedRatioMedian: any ? pyFloat(pyRound(middle(ratios), 4)) : null,
      secondsPerChunkMedian: any ? pyFloat(pyRound(middle(seconds), 3)) : null,
      secondsPerChunkMax: any ? pyFloat(pyRound(seconds[seconds.length - 1], 3)) : null,
      errors: errors.length,
      errorIndices: [...new Set(errors.map((e) => e.index))].sort((a, b) => a - b),
    },
    chunks: coverages.map(chunkDocument),
    errors,
    skipped,
  };
}

export interface CoverageDocument extends Record<string, unknown> {
  summary: {
    chunksAligned: number;
    chunksSkipped: number;
    chunksFailed: number;
    failedIndices: number[];
    alignedRatioMin: unknown;
    alignedRatioMedian: unknown;
    secondsPerChunkMedian: unknown;
    secondsPerChunkMax: unknown;
    errors: number;
    errorIndices: number[];
  };
}
