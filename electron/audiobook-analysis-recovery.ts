export interface RecoverableAudiobookCue {
  index: number;
  text: string;
  startTime: number;
  endTime: number;
}

export interface RecoverableAudiobookChunk<TCue extends RecoverableAudiobookCue> {
  cues: TCue[];
  promptText: string;
}

export type AudiobookAnalysisSkipReason =
  | 'ai-refusal'
  | 'copyright'
  | 'empty-response'
  | 'output-limit'
  | 'invalid-response'
  | 'request-error';

export interface AudiobookAnalysisSkippedChunk {
  topLevelChunkNumber: number;
  totalTopLevelChunks: number;
  cueStartIndex: number;
  cueEndIndex: number;
  startTime: number;
  endTime: number;
  reason: AudiobookAnalysisSkipReason;
  error: string;
  text: string;
  responsePreview?: string;
  attempts: number;
  splitDepth: number;
}

export interface AudiobookAnalysisFailureClass {
  reason: AudiobookAnalysisSkipReason;
  recoverable: boolean;
  /** Content failures improve on smaller cue ranges; transport failures do not. */
  splitAllowed: boolean;
  /** Transient transport failures retry the identical request before recording a gap. */
  retrySameChunk: boolean;
}

export interface AudiobookAnalysisRecoveryEvent {
  action: 'retrying' | 'splitting' | 'skipped';
  topLevelChunkNumber: number;
  totalTopLevelChunks: number;
  cueStartIndex: number;
  cueEndIndex: number;
  attempt: number;
  reason: AudiobookAnalysisSkipReason;
  message: string;
}

export interface AudiobookAnalysisRecoveryOptions<TCue extends RecoverableAudiobookCue, TFlag> {
  chunk: RecoverableAudiobookChunk<TCue>;
  topLevelChunkNumber: number;
  totalTopLevelChunks: number;
  existingSkippedCount: number;
  maxSkippedChunks: number;
  signal?: AbortSignal;
  makeChunk: (cues: TCue[]) => RecoverableAudiobookChunk<TCue>;
  analyze: (
    chunk: RecoverableAudiobookChunk<TCue>,
    attempt: number,
  ) => Promise<string>;
  parse: (response: string, chunk: RecoverableAudiobookChunk<TCue>) => TFlag[];
  classifyError: (error: unknown) => AudiobookAnalysisFailureClass;
  classifyInvalidResponse?: (
    response: string,
    validationError: Error,
  ) => AudiobookAnalysisFailureClass;
  onInvalidResponse?: (
    response: string,
    error: Error,
    chunk: RecoverableAudiobookChunk<TCue>,
    attempt: number,
  ) => void;
  onEvent?: (event: AudiobookAnalysisRecoveryEvent) => void;
  delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export interface AudiobookAnalysisRecoveryResult<TFlag> {
  flags: TFlag[];
  skippedChunks: AudiobookAnalysisSkippedChunk[];
  requestAttempts: number;
}

export class TooManyAudiobookAnalysisSkipsError extends Error {
  constructor(
    public readonly skippedChunks: AudiobookAnalysisSkippedChunk[],
    maximum: number,
  ) {
    super(`TOO_MANY_ANALYSIS_SKIPS: ${maximum} transcript ranges could not be analyzed. Aborting instead of publishing a severely incomplete report.`);
    this.name = 'TooManyAudiobookAnalysisSkipsError';
  }
}

function stripThinkAndMarkdown(response: string): string {
  let text = response.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();
  return text;
}

function extractBalancedArray(text: string): string | null {
  const start = text.indexOf('[');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '[') depth++;
    if (char === ']') depth--;
    if (depth === 0) return text.slice(start, index + 1);
  }
  return null;
}

/** Briefcase-style conservative JSON extraction, adapted to an array contract. */
export function parseAnalysisJsonArray(response: string): unknown[] {
  if (!response || typeof response !== 'string') throw new Error('Audiobook analysis response is empty');
  const candidate = extractBalancedArray(stripThinkAndMarkdown(response));
  if (!candidate) throw new Error('Audiobook analysis response contains no complete JSON array');
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (!Array.isArray(parsed)) throw new Error('Audiobook analysis response must be a JSON array');
    return parsed;
  } catch (directError) {
    // Only repairs known syntax accidents that cannot alter semantic values.
    const repaired = candidate
      .replace(/,\s*([\]}])/g, '$1')
      .replace(/'(\w+)'(\s*:)/g, '"$1"$2')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    try {
      const parsed: unknown = JSON.parse(repaired);
      if (!Array.isArray(parsed)) throw new Error('Audiobook analysis response must be a JSON array');
      return parsed;
    } catch {
      throw new Error(`Audiobook analysis returned malformed JSON: ${(directError as Error).message}`);
    }
  }
}

function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshteinDistance(first: string, second: string): number {
  if (first === second) return 0;
  if (!first.length) return second.length;
  if (!second.length) return first.length;
  let previous = Array.from({ length: second.length + 1 }, (_, index) => index);
  for (let row = 1; row <= first.length; row++) {
    const current = [row];
    for (let column = 1; column <= second.length; column++) {
      current[column] = first[row - 1] === second[column - 1]
        ? previous[column - 1]
        : 1 + Math.min(previous[column], current[column - 1], previous[column - 1]);
    }
    previous = current;
  }
  return previous[second.length];
}

function similarity(first: string, second: string): number {
  if (first === second) return 1;
  const max = Math.max(first.length, second.length);
  return max ? 1 - levenshteinDistance(first, second) / max : 0;
}

function bestWindowSimilarity(normalizedQuote: string, normalizedTranscript: string): number {
  const quoteWords = normalizedQuote.split(' ');
  const transcriptWords = normalizedTranscript.split(' ');
  const minimumWindow = Math.max(1, quoteWords.length - 2);
  const maximumWindow = Math.min(transcriptWords.length, quoteWords.length + 2);
  let best = 0;
  for (let size = minimumWindow; size <= maximumWindow; size++) {
    for (let start = 0; start + size <= transcriptWords.length; start++) {
      best = Math.max(best, similarity(normalizedQuote, transcriptWords.slice(start, start + size).join(' ')));
    }
  }
  return best;
}

/** Character/word-window score used only to rank otherwise defensible matches. */
export function quoteTranscriptMatchScore(quote: string, transcript: string): number {
  const normalizedQuote = normalizeForComparison(quote);
  const normalizedTranscript = normalizeForComparison(transcript);
  if (normalizedQuote.length < 3 || normalizedTranscript.length < 3) return 0;
  if (normalizedTranscript.includes(normalizedQuote)) return 1;
  const prefix50 = normalizedQuote.slice(0, 50);
  if (prefix50.length >= 15 && normalizedTranscript.includes(prefix50)) return 0.96;
  const prefix25 = normalizedQuote.slice(0, 25);
  if (prefix25.length >= 15 && normalizedTranscript.includes(prefix25)) return 0.92;
  return bestWindowSimilarity(normalizedQuote, normalizedTranscript);
}

const COMMON_QUOTE_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of', 'in',
  'for', 'on', 'with', 'at', 'by', 'from', 'as', 'and', 'but', 'or', 'not', 'that',
  'this', 'these', 'those', 'what', 'which', 'who', 'i', 'you', 'he', 'she', 'it',
  'we', 'they', 'my', 'your', 'his', 'our', 'their', 'about', 'because', 'can',
  'could', 'would', 'should', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
]);

/**
 * Briefcase-style quote reconciliation. A fuzzy match never changes timing by
 * itself; callers retain the model's in-range cue ids and replace the quote with
 * exact authoritative VTT text before persistence.
 */
export function fuzzyQuoteMatchesTranscript(quote: string, transcript: string): boolean {
  const normalizedQuote = normalizeForComparison(quote);
  const normalizedTranscript = normalizeForComparison(transcript);
  if (normalizedQuote.length < 3 || normalizedTranscript.length < 3) return false;
  if (normalizedTranscript.includes(normalizedQuote)) return true;

  const prefix50 = normalizedQuote.slice(0, 50);
  if (prefix50.length >= 15 && normalizedTranscript.includes(prefix50)) return true;
  const prefix25 = normalizedQuote.slice(0, 25);
  if (prefix25.length >= 15 && normalizedTranscript.includes(prefix25)) return true;

  const quoteWords = normalizedQuote.split(' ');
  const transcriptWords = normalizedTranscript.split(' ');
  const bestSimilarity = bestWindowSimilarity(normalizedQuote, normalizedTranscript);
  if (bestSimilarity >= 0.65) return true;

  const distinctive = quoteWords.filter(word => word.length > 3 && !COMMON_QUOTE_WORDS.has(word));
  if (!distinctive.length) return false;
  const transcriptSet = new Set(transcriptWords);
  let matched = 0;
  for (const word of distinctive) {
    if (transcriptSet.has(word)
      || [...transcriptSet].some(candidate => candidate.length > 3 && similarity(word, candidate) > 0.75)) {
      matched++;
    }
  }
  return matched / distinctive.length > 0.4;
}

export interface LocatedAudiobookQuoteRange {
  startPosition: number;
  endPosition: number;
  score: number;
}

/**
 * Locate a quote elsewhere inside the submitted chunk when a model returns bad
 * cue ids. Repeated disjoint matches are ambiguous and deliberately rejected.
 */
export function locateAudiobookQuoteCueRange<TCue extends RecoverableAudiobookCue>(
  quote: string,
  cues: TCue[],
  maximumCueSpan = 8,
): LocatedAudiobookQuoteRange | null {
  if (!cues.length || maximumCueSpan < 1) return null;
  const candidates: Array<LocatedAudiobookQuoteRange & { textLength: number }> = [];
  const spanLimit = Math.min(cues.length, maximumCueSpan);
  for (let startPosition = 0; startPosition < cues.length; startPosition++) {
    let transcript = '';
    for (let endPosition = startPosition; endPosition < cues.length && endPosition - startPosition < spanLimit; endPosition++) {
      transcript += `${transcript ? ' ' : ''}${cues[endPosition].text}`;
      const score = quoteTranscriptMatchScore(quote, transcript);
      if (score >= 0.65) candidates.push({ startPosition, endPosition, score, textLength: transcript.length });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((first, second) =>
    second.score - first.score
    || (first.endPosition - first.startPosition) - (second.endPosition - second.startPosition)
    || Math.abs(first.textLength - quote.length) - Math.abs(second.textLength - quote.length)
    || first.startPosition - second.startPosition,
  );
  const best = candidates[0];
  const ambiguous = candidates.some(candidate => {
    if (candidate === best) return false;
    const disjoint = candidate.endPosition < best.startPosition
      || candidate.startPosition > best.endPosition;
    return disjoint && Math.abs(candidate.score - best.score) < 0.05;
  });
  if (ambiguous) return null;
  return { startPosition: best.startPosition, endPosition: best.endPosition, score: best.score };
}

function abortError(): Error {
  return new Error('Job cancelled');
}

async function defaultDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(abortError());
      }, { once: true });
    }
  });
}

/** Split as close as possible to half the text, but only between complete cues. */
export function splitAudiobookCueChunk<TCue extends RecoverableAudiobookCue>(
  chunk: RecoverableAudiobookChunk<TCue>,
  makeChunk: (cues: TCue[]) => RecoverableAudiobookChunk<TCue>,
): [RecoverableAudiobookChunk<TCue>, RecoverableAudiobookChunk<TCue>] | null {
  if (chunk.cues.length < 2) return null;
  const target = chunk.cues.reduce((sum, cue) => sum + cue.text.length, 0) / 2;
  let cumulative = 0;
  let bestBoundary = 1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let boundary = 1; boundary < chunk.cues.length; boundary++) {
    cumulative += chunk.cues[boundary - 1].text.length;
    const distance = Math.abs(target - cumulative);
    if (distance < bestDistance) {
      bestBoundary = boundary;
      bestDistance = distance;
    }
  }
  return [makeChunk(chunk.cues.slice(0, bestBoundary)), makeChunk(chunk.cues.slice(bestBoundary))];
}

/**
 * Cleanup-style recovery adapted for analysis: retry transient transport
 * failures, immediately split invalid/content-limited responses at cue
 * boundaries, and record irrecoverable leaves. Invalid model output is never
 * resent at the same size: that duplicates the expensive analysis request.
 */
export async function recoverAudiobookAnalysisChunk<TCue extends RecoverableAudiobookCue, TFlag>(
  options: AudiobookAnalysisRecoveryOptions<TCue, TFlag>,
): Promise<AudiobookAnalysisRecoveryResult<TFlag>> {
  const localSkipped: AudiobookAnalysisSkippedChunk[] = [];
  let requestAttempts = 0;
  const delay = options.delay || defaultDelay;

  const process = async (
    chunk: RecoverableAudiobookChunk<TCue>,
    splitDepth: number,
  ): Promise<TFlag[]> => {
    if (options.signal?.aborted) throw abortError();
    let lastFailure: AudiobookAnalysisFailureClass | null = null;
    let lastError = new Error('Analysis returned no usable response');
    let lastResponse = '';
    let attemptsForChunk = 0;

    for (let attempt = 1; attempt <= 3; attempt++) {
      if (options.signal?.aborted) throw abortError();
      attemptsForChunk++;
      requestAttempts++;
      try {
        const response = await options.analyze(chunk, attempt);
        lastResponse = response;
        try {
          return options.parse(response, chunk);
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          lastFailure = options.classifyInvalidResponse?.(response, lastError) || {
            reason: 'invalid-response',
            recoverable: true,
            splitAllowed: true,
            retrySameChunk: false,
          };
          options.onInvalidResponse?.(response, lastError, chunk, attempt);
          break;
        }
      } catch (error) {
        if (options.signal?.aborted) throw abortError();
        lastError = error instanceof Error ? error : new Error(String(error));
        lastFailure = options.classifyError(error);
        if (!lastFailure.recoverable) throw lastError;
        if (lastFailure.retrySameChunk && attempt < 3) {
          options.onEvent?.({
            action: 'retrying',
            topLevelChunkNumber: options.topLevelChunkNumber,
            totalTopLevelChunks: options.totalTopLevelChunks,
            cueStartIndex: chunk.cues[0].index,
            cueEndIndex: chunk.cues[chunk.cues.length - 1].index,
            attempt: attempt + 1,
            reason: lastFailure.reason,
            message: lastError.message,
          });
          await delay(attempt * 2000, options.signal);
          continue;
        }
        break;
      }
    }

    const failure = lastFailure || {
      reason: 'invalid-response' as const,
      recoverable: true,
      splitAllowed: true,
      retrySameChunk: false,
    };
    const split = failure.splitAllowed ? splitAudiobookCueChunk(chunk, options.makeChunk) : null;
    if (split) {
      options.onEvent?.({
        action: 'splitting',
        topLevelChunkNumber: options.topLevelChunkNumber,
        totalTopLevelChunks: options.totalTopLevelChunks,
        cueStartIndex: chunk.cues[0].index,
        cueEndIndex: chunk.cues[chunk.cues.length - 1].index,
        attempt: attemptsForChunk,
        reason: failure.reason,
        message: lastError.message,
      });
      const first = await process(split[0], splitDepth + 1);
      const second = await process(split[1], splitDepth + 1);
      return [...first, ...second];
    }

    const skipped: AudiobookAnalysisSkippedChunk = {
      topLevelChunkNumber: options.topLevelChunkNumber,
      totalTopLevelChunks: options.totalTopLevelChunks,
      cueStartIndex: chunk.cues[0].index,
      cueEndIndex: chunk.cues[chunk.cues.length - 1].index,
      startTime: chunk.cues[0].startTime,
      endTime: chunk.cues[chunk.cues.length - 1].endTime,
      reason: failure.reason,
      error: lastError.message,
      text: chunk.cues.map(cue => cue.text).join(' '),
      responsePreview: lastResponse ? lastResponse.slice(0, 500) : undefined,
      attempts: attemptsForChunk,
      splitDepth,
    };
    localSkipped.push(skipped);
    options.onEvent?.({
      action: 'skipped',
      topLevelChunkNumber: options.topLevelChunkNumber,
      totalTopLevelChunks: options.totalTopLevelChunks,
      cueStartIndex: skipped.cueStartIndex,
      cueEndIndex: skipped.cueEndIndex,
      attempt: attemptsForChunk,
      reason: skipped.reason,
      message: skipped.error,
    });
    if (options.existingSkippedCount + localSkipped.length >= options.maxSkippedChunks) {
      throw new TooManyAudiobookAnalysisSkipsError([...localSkipped], options.maxSkippedChunks);
    }
    return [];
  };

  const flags = await process(options.chunk, 0);
  return { flags, skippedChunks: localSkipped, requestAttempts };
}
