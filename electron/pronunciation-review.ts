/**
 * THE PRONUNCIATION GUIDE'S REVIEW — read for BookForge's review window, and a
 * person's edits written back (Owen, 2026-10-03: *"they can go back to foundry when
 * its done and review the words"*).
 *
 * WHAT A PERSON CHANGES BECOMES THEIRS. A form whose meanings or readings they
 * changed is `by: 'person'`; a spot they moved is `byPerson`. A cleanup reads the
 * guide as it stands, so an edit here is what the next cleanup is handed — and it
 * lasts until the guide STARTS OVER, which drops a person's decisions
 * with the model's (*"i dont think they should be protected on every clean"*).
 *
 * "LEAVE TO THE NARRATOR" means the printed text reaches the narrator untouched:
 * for a whole form, `as-printed` with no meanings (every spot kept, and protected
 * from the cleaner); for one spot, a meaning read as printed. Either way the spot
 * is in the guide, so the cleaner cannot rewrite it.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  guidePathsOfProject, readGlossary, writeGlossary,
  type GlossaryEntry, type GlossarySense, type PlacedOccurrence,
} from './narration-glossary';
import type {
  GuideReview, GuideReviewForm, GuideReviewSave, GuideReviewSense,
} from '../shared/pronunciation-guide';

/** A sentence for a spot the guide stored without one, from a fresh listing of the book. */
export type SentenceOf = (at: string, printed: string, nth: number) => string | null;

function versionOf(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function titleOf(projectDir: string): string {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectDir, 'project.json'), 'utf8').replace(/^﻿/, '')) as {
    title?: unknown; key?: unknown;
  };
  if (typeof manifest.title === 'string' && manifest.title !== '') return manifest.title;
  if (typeof manifest.key === 'string') return manifest.key;
  throw new Error(`${path.join(projectDir, 'project.json')} names neither a title nor a key.`);
}

/**
 * The guide as the review shows it, or null when the book has none yet.
 * `sentenceOf` fills a spot the guide stored without its sentence (a guide built
 * before spots carried one).
 */
export function readGuideReview(projectDir: string, sentenceOf: SentenceOf | null): GuideReview | null {
  const files = guidePathsOfProject(projectDir);
  if (!fs.existsSync(files.glossary)) return null;
  const glossary = readGlossary(files.glossary, files.book);
  const forms: GuideReviewForm[] = glossary.entries.map((entry) => ({
    key: entry.key,
    kind: entry.kind,
    count: entry.count,
    decision: entry.decision,
    senses: entry.senses.map((s): GuideReviewSense => ({
      meaning: s.meaning, reading: s.reading, periodIsPart: s.periodIsPart,
      ...(s.problem === undefined ? {} : { problem: s.problem }),
    })),
    spots: entry.occurrences.map((o) => ({
      at: o.at, nth: o.nth, printed: o.printed, sense: o.sense, p: o.p, byPerson: o.byPerson === true,
      sentence: o.sentence ?? (sentenceOf === null ? null : sentenceOf(o.at, o.printed, o.nth)),
    })),
    by: entry.by,
    why: entry.why,
  }));
  return {
    projectDir,
    title: titleOf(projectDir),
    version: versionOf(files.glossary),
    built: glossary.built ?? null,
    forms,
  };
}

/** Whether a review needs the book listed to show its sentences. */
export function reviewNeedsSentences(projectDir: string): boolean {
  const files = guidePathsOfProject(projectDir);
  if (!fs.existsSync(files.glossary)) return false;
  return readGlossary(files.glossary, files.book).entries.some((e) => e.occurrences.some((o) => o.sentence === undefined));
}

const formKey = (f: { kind: string; key: string }): string => `${f.kind}\u0000${f.key}`;
const spotKey = (o: { at: string; printed: string; nth: number }): string => `${o.at}\u0000${o.printed}\u0000${o.nth}`;

function sameSenses(a: readonly GlossarySense[], b: readonly GuideReviewSense[]): boolean {
  return a.length === b.length && a.every((s, i) => s.meaning === b[i]!.meaning && s.reading === b[i]!.reading
    && s.periodIsPart === b[i]!.periodIsPart);
}

/**
 * WRITE A PERSON'S EDITS. Refused, by name, when the guide changed since the
 * review read it — the review is reopened rather than one set of decisions
 * written over another nobody saw.
 */
export function saveGuideReview(save: GuideReviewSave): { forms: number; spots: number } {
  const files = guidePathsOfProject(save.projectDir);
  if (!fs.existsSync(files.glossary)) {
    throw new Error('This book has no pronunciation guide any more, so there is nothing to save the review into.');
  }
  if (versionOf(files.glossary) !== save.version) {
    throw new Error('The pronunciation guide changed while you were reviewing it (a guide step ran). Nothing was '
      + 'saved — reopen the review to see the guide as it is now.');
  }
  const glossary = readGlossary(files.glossary, files.book);
  const edits = new Map(save.forms.map((f) => [formKey(f), f] as const));
  let formsChanged = 0;
  let spotsChanged = 0;
  const entries: GlossaryEntry[] = glossary.entries.map((entry) => {
    const edit = edits.get(formKey(entry));
    if (edit === undefined) return entry;
    for (const sense of edit.senses) {
      if (typeof sense.meaning !== 'string' || typeof sense.reading !== 'string' || typeof sense.periodIsPart !== 'boolean') {
        throw new Error(`The review sent a meaning of "${entry.key}" that is not a meaning, a reading and a period rule.`);
      }
    }
    const leftWhole = edit.decision === 'as-printed' && edit.senses.length === 0;
    const meaningsChanged = edit.decision !== entry.decision || !sameSenses(entry.senses, edit.senses);
    const before = new Map(entry.occurrences.map((o) => [spotKey(o), o] as const));
    const spots: PlacedOccurrence[] = leftWhole ? [] : edit.spots.map((spot) => {
      const was = before.get(spotKey(spot));
      if (was === undefined) {
        throw new Error(`The review sent a spot of "${entry.key}" (${spot.at}) the guide does not have.`);
      }
      if (spot.sense !== null && (!Number.isInteger(spot.sense) || spot.sense < 0 || spot.sense >= edit.senses.length)) {
        throw new Error(`The review put a spot of "${entry.key}" in meaning ${spot.sense}, which it does not have.`);
      }
      if (spot.sense === was.sense) return was;
      spotsChanged += 1;
      return { ...was, sense: spot.sense, p: null, byPerson: true };
    });
    const moved = spots.some((s, i) => s !== entry.occurrences[i]);
    if (!meaningsChanged && !moved) return entry;
    formsChanged += 1;
    return {
      ...entry,
      decision: edit.decision,
      // A meaning a person wrote carries no model classification: it is taken as written.
      senses: meaningsChanged
        ? edit.senses.map((s) => ({ meaning: s.meaning, reading: s.reading, periodIsPart: s.periodIsPart }))
        : entry.senses,
      occurrences: spots,
      by: meaningsChanged ? 'person' : entry.by,
      why: meaningsChanged ? `Decided in the review, ${new Date().toISOString().slice(0, 10)}.` : entry.why,
      at: new Date().toISOString(),
    };
  });
  writeGlossary(files.glossary, { ...glossary, entries });
  return { forms: formsChanged, spots: spotsChanged };
}
