import { Injectable } from '@angular/core';
import { PlayableSentence, PlayableChapter } from '../models/play.types';

/**
 * PlayTextService - Parse EPUB text into sentences for TTS playback
 *
 * This service handles text segmentation for the Play Tab, breaking
 * chapter text into individual sentences that can be synthesized
 * and highlighted during playback.
 */
@Injectable({
  providedIn: 'root'
})
export class PlayTextService {
  /**
   * Sentence-ending punctuation patterns
   */
  private readonly SENTENCE_END = /([.!?]+["'\u201D\u2019]?)\s+/g;

  /**
   * Patterns that look like sentence endings but aren't
   */
  private readonly FALSE_ENDINGS = [
    /\bMr\.\s/gi,
    /\bMrs\.\s/gi,
    /\bMs\.\s/gi,
    /\bDr\.\s/gi,
    /\bProf\.\s/gi,
    /\bSt\.\s/gi,
    /\bJr\.\s/gi,
    /\bSr\.\s/gi,
    /\bInc\.\s/gi,
    /\bLtd\.\s/gi,
    /\bCo\.\s/gi,
    /\bvs\.\s/gi,
    /\betc\.\s/gi,
    /\bi\.e\.\s/gi,
    /\be\.g\.\s/gi,
    /\bcf\.\s/gi,
    /\bNo\.\s/gi,
    /\bVol\.\s/gi,
    /\bFig\.\s/gi,
    /\bp\.\s/gi,
    /\bpp\.\s/gi,
    /\bEd\.\s/gi,
    /\bRev\.\s/gi,
    /\bGen\.\s/gi,
    /\bCol\.\s/gi,
    /\bLt\.\s/gi,
    /\bSgt\.\s/gi,
  ];

  /**
   * Parse chapter text into sentences
   */
  parseChapter(chapterId: string, title: string, text: string): PlayableChapter {
    const sentences = this.splitIntoSentences(text);

    return {
      id: chapterId,
      title,
      text,
      sentences
    };
  }

  /**
   * Split text into sentences
   */
  splitIntoSentences(text: string): PlayableSentence[] {
    // Normalize whitespace
    text = text.replace(/\s+/g, ' ').trim();

    if (!text) {
      return [];
    }

    // Replace false endings with placeholders
    let processedText = text;
    const placeholders: Map<string, string> = new Map();

    this.FALSE_ENDINGS.forEach((pattern, index) => {
      const placeholder = `\x00ABBR${index}\x00`;
      processedText = processedText.replace(pattern, (match) => {
        placeholders.set(placeholder, match);
        return placeholder;
      });
    });

    // Split on sentence endings
    const parts: string[] = [];
    let lastIndex = 0;

    processedText.replace(this.SENTENCE_END, (match, punctuation, offset) => {
      const sentence = processedText.slice(lastIndex, offset) + punctuation;
      parts.push(sentence.trim());
      lastIndex = offset + match.length;
      return match;
    });

    // Add remaining text
    if (lastIndex < processedText.length) {
      const remaining = processedText.slice(lastIndex).trim();
      if (remaining) {
        parts.push(remaining);
      }
    }

    // Restore placeholders and build sentences
    const sentences: PlayableSentence[] = [];
    let charOffset = 0;

    parts.forEach((part, index) => {
      // Restore abbreviations
      let restored = part;
      placeholders.forEach((original, placeholder) => {
        restored = restored.replace(placeholder, original);
      });

      // Skip empty sentences
      restored = restored.trim();
      if (!restored) {
        return;
      }

      // Find original position in text
      const charStart = text.indexOf(restored, charOffset);
      const charEnd = charStart + restored.length;

      sentences.push({
        index,
        text: restored,
        charStart: charStart >= 0 ? charStart : charOffset,
        charEnd: charStart >= 0 ? charEnd : charOffset + restored.length
      });

      charOffset = charEnd;
    });

    // Re-index after filtering
    sentences.forEach((s, i) => s.index = i);

    return sentences;
  }

  /**
   * Merge short sentences that are likely fragments
   * (e.g., dialog tags like "he said")
   */
  mergeSentences(sentences: PlayableSentence[], minLength: number = 20): PlayableSentence[] {
    const merged: PlayableSentence[] = [];

    for (let i = 0; i < sentences.length; i++) {
      const current = sentences[i];

      // If current is short and there's a next sentence, merge them
      if (current.text.length < minLength && i < sentences.length - 1) {
        const next = sentences[i + 1];
        merged.push({
          index: merged.length,
          text: current.text + ' ' + next.text,
          charStart: current.charStart,
          charEnd: next.charEnd
        });
        i++; // Skip next sentence
      } else {
        merged.push({
          ...current,
          index: merged.length
        });
      }
    }

    return merged;
  }

  /**
   * Split long sentences for better TTS performance
   * (XTTS works best with sentences under ~200 chars)
   */
  splitLongSentences(sentences: PlayableSentence[], maxLength: number = 200): PlayableSentence[] {
    const result: PlayableSentence[] = [];

    for (const sentence of sentences) {
      if (sentence.text.length <= maxLength) {
        result.push({
          ...sentence,
          index: result.length
        });
        continue;
      }

      // Split on commas, semicolons, or conjunctions
      const splits = this.splitLongText(sentence.text, maxLength);
      let charOffset = sentence.charStart;

      for (const split of splits) {
        result.push({
          index: result.length,
          text: split,
          charStart: charOffset,
          charEnd: charOffset + split.length
        });
        charOffset += split.length + 1; // +1 for space
      }
    }

    return result;
  }

  /**
   * Split long text on natural boundaries
   */
  private splitLongText(text: string, maxLength: number): string[] {
    const parts: string[] = [];
    let remaining = text;

    while (remaining.length > maxLength) {
      // Try to split on comma, semicolon, or conjunction
      let splitIndex = -1;

      // Look for split points
      const patterns = [
        /,\s+/g,
        /;\s+/g,
        /\s+and\s+/gi,
        /\s+but\s+/gi,
        /\s+or\s+/gi,
        /\s+—\s+/g,
        /\s+-\s+/g,
      ];

      for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(remaining)) !== null) {
          if (match.index > 0 && match.index < maxLength && match.index > splitIndex) {
            splitIndex = match.index + match[0].length;
          }
        }
        if (splitIndex > 0) break;
      }

      // If no good split point, split on space
      if (splitIndex <= 0) {
        const spaceIndex = remaining.lastIndexOf(' ', maxLength);
        splitIndex = spaceIndex > 0 ? spaceIndex + 1 : maxLength;
      }

      parts.push(remaining.slice(0, splitIndex).trim());
      remaining = remaining.slice(splitIndex).trim();
    }

    if (remaining) {
      parts.push(remaining);
    }

    return parts;
  }

  /**
   * Get optimized sentences for TTS
   * Applies both merging short fragments and splitting long sentences
   */
  optimizeForTTS(sentences: PlayableSentence[]): PlayableSentence[] {
    // First merge very short fragments
    let optimized = this.mergeSentences(sentences, 15);

    // Then split very long sentences
    optimized = this.splitLongSentences(optimized, 250);

    return optimized;
  }
}
