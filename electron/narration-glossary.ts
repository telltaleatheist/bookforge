/**
 * THE NARRATION GLOSSARY — the book's pronunciation guide: how each of its
 * printed forms is said, decided from the WHOLE BOOK before the cleanup reads it,
 * and written into every spot it is printed (Owen, 2026-10-03).
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 *
 * The cleanup asks about one sentence at a time, and one sentence is often not
 * enough to know what a form IS. *Deathstalker: Hellworld* prints "esp" 26
 * times for a psychic sense; shown "touched the sphere with her esp." alone the
 * model read it "especial", and the book came out saying "ESP" once and
 * "especial" twice — and "Wolf the Fourth" for a planet everyone else calls
 * "Wolf Four". The evidence is in the book, just not in the sentence.
 *
 * And one form can be two things in one book. Owen: *"we need a way to know if
 * it's an instance of "esp" the mental ability or "esp." meaning especially.
 * there might be multiple use cases in one book."* So a form is decided in two
 * steps, each by the kind of question its model is good at.
 *
 * ── What ────────────────────────────────────────────────────────────────────
 *
 *   1. COLLECT — Foundry lists the book's printed forms (`foundry clean-forms`:
 *      roman numerals WITH the word before them, runs of capitals outside
 *      headings, abbreviations), each with sample sentences spread across the
 *      book — every printed spelling among them — and EVERY occurrence, named as
 *      a spot (block, which run of that spelling, its sentence). Code decides
 *      nothing.
 *   2. MEANINGS — a chat per form, with its samples: as printed, or the one or
 *      more MEANINGS the book uses it in, each with how it is said ("ESP, the
 *      psychic sense" → "ESP"; "esp., short for especially" → "especially").
 *   3. PLACING — the decide verb, per OCCURRENCE: which of those meanings is
 *      this one, or none of them. A fixed choice over one sentence is exactly
 *      what the decide door answers in one forward pass. Every occurrence of a
 *      form with a reading is placed — a form with ONE meaning too, because a
 *      meaning the samples missed shows up as "none of these".
 *   4. ONE SECOND LOOK — when occurrences came back "none of these", the chat is
 *      asked again with THOSE sentences as evidence, and the form is placed again.
 *   5. THE GUIDE — every placed occurrence becomes a reading AT ITS SPOT
 *      (`--fixed-readings` with `at`/`nth`), handed to the triage and the
 *      cleanup alike. An occurrence nobody could place confidently is left as
 *      printed, to the sentence pass, exactly as before the glossary existed.
 *
 * ── Measured before it was built (2026-10-03, Hellworld + The Pursuit of Power) ──
 *
 * Owen: *"we'll test it. if it isnt going to work the way we expect, we wont
 * implement."* The meanings step is the measured one: the clean's own 9B was
 * unstable ("esp" was ESP, then "espionage"); the 27B — the server's `analysis`
 * model on both machines, named by the server, never by this file — got
 * Hellworld 3/3 and every ruler right, 180 of 184 identical across two runs.
 * The decide verb as the FIRST step (choosing reading / as printed) was slower
 * and wrong on "esp"; it is used here for what it is good at, placing.
 *
 * ── Ownership ───────────────────────────────────────────────────────────────
 *
 * Owen: *"foundry is for written texts. bookforge extends foundry's
 * functionality into spoken text"* and *"it should effectively be a part of the
 * cleaning logic"*. So the glossary is this app's; Foundry knows only how to list
 * a book's forms and a list of strings to read at given spots. It runs inside the
 * cleanup's own queue step, by default, before the engine is spawned.
 *
 * ── Cost, and what is never paid twice ──────────────────────────────────────
 *
 * Selective by construction: one chat per form (Hellworld: 3; a history book
 * ~180) and one decide item per occurrence of a form with a reading. Meanings are
 * cached under the exact question they answered (form, samples, prompt version,
 * model); placings under the meanings and the occurrence list. So the cleanup
 * behind a triage asks nothing, and a re-clean asks only what its edits changed.
 * A PERSON's meanings are never asked again, and an occurrence a person placed is
 * never placed again.
 *
 * ── Its own session, closed before the engine starts ────────────────────────
 *
 * The analysis model is not the cleanup's model, so the two cannot share a
 * session. The glossary opens one, asks, and CLOSES it before Foundry opens the
 * cleanup's — a session left open would hold the card against Foundry's own.
 * Not `withCrucibleLease`: inside a row scope that hands the session to the row.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { CrucibleBusy, CrucibleUnreachable } from '@crucible/client';

import { asSessionWait, takeCrucibleLease, type CrucibleLease } from './crucible/lease';
import { CRUCIBLE_CLIENT_NAME, crucibleClientFor } from './crucible/servers';
import { isUpstreamModelId } from './crucible/text-acts';
import { modelFromCapability, processTextVenueHost } from './crucible/text-venue';
import type { FoundryFormsLister, FoundryJobRequest } from './foundry-host-queue';

// ─────────────────────────────────────────────────────────────────────────────
// The files
// ─────────────────────────────────────────────────────────────────────────────

export const GLOSSARY_FORMAT = 'narration-glossary/v2';
/** The prompt's version: meanings decided under another prompt are a different question. */
export const GLOSSARY_PROMPT_VERSION = 'g4';
/** What Foundry reads (its src/clean/fixed-readings.ts). */
const FIXED_READINGS_FORMAT = 'fixed-readings/v1';

/** One occurrence of a form, as Foundry names it (`printed-forms/v1`). */
export interface FormOccurrence {
  /** The block's target key. */
  at: string;
  /** Which whole-token run of `printed` in that block, from 0. */
  nth: number;
  printed: string;
  sentence: string;
  /** Where in `sentence` it starts. */
  inSentence: number;
  endsSentence: boolean;
}

/** One printed form, as Foundry lists it (`printed-forms/v1`). */
export interface PrintedForm {
  key: string;
  kind: 'roman' | 'caps' | 'abbreviation';
  count: number;
  printed: Record<string, number>;
  samples: { parts: string; sentence: string }[];
  occurrences: FormOccurrence[];
}

/**
 * WHAT A MEANING IS — the model's classification, from which one reading follows
 * by rule: an ACRONYM is said as its capitals ("esp" → "ESP"), whatever the model
 * offered as its reading. Measured 2026-10-03: told in the prompt never to expand
 * an acronym, the 27B still read the psychic sense "extrasensory perception" once
 * the same book also used "esp." as an abbreviation — so the rule moved out of the
 * prompt's hope and into the classification the model is good at.
 */
export type SenseKind = 'acronym' | 'abbreviation' | 'numeral' | 'word';

/** One way the book uses a form, and how it is said. */
export interface GlossarySense {
  /** A few words naming it: "ESP, the psychic sense". */
  meaning: string;
  /** What it is (see {@link SenseKind}). Absent in a person's sense, which is taken as written. */
  kind?: SenseKind;
  /** What the narrator says. '' means as printed. */
  reading: string;
  /**
   * Whether a period right after the form, in this meaning, is the
   * ABBREVIATION's ("esp." for especially, "ed.") — consumed by the reading
   * unless it also ends the sentence — or can only be the SENTENCE's ("her
   * esp." for the psychic sense), and stays.
   */
  periodIsPart: boolean;
  /** Why this meaning's reading cannot be given to the book, when it cannot. Its spots stay as printed. */
  problem?: string;
}

/** Where one occurrence was placed. */
export interface PlacedOccurrence {
  at: string;
  nth: number;
  printed: string;
  /** The index of its meaning in `senses`, or null: placed nowhere, left to the sentence pass. */
  sense: number | null;
  /** The decide door's confidence in that placing, or null when a person placed it. */
  p: number | null;
  /** A person placed it: never placed again. */
  byPerson?: true;
}

export interface GlossaryEntry {
  key: string;
  kind: PrintedForm['kind'];
  count: number;
  printed: Record<string, number>;
  /** `as-printed`: nothing to say. `reading`: see `senses`. */
  decision: 'as-printed' | 'reading';
  senses: GlossarySense[];
  /** The model's sentence of evidence, or what went wrong. */
  why: string;
  /** Who decided the meanings. A PERSON's are never asked again and never overwritten. */
  by: 'model' | 'person';
  model?: string;
  /** The meanings question's digest — form, samples, prompt version, model. */
  question?: string;
  /** The placing's digest — meanings and occurrences — so a placing is redone only when either moved. */
  placed?: string;
  occurrences: PlacedOccurrence[];
  at: string;
}

export interface GlossaryFile {
  format: typeof GLOSSARY_FORMAT;
  /** The project key the glossary belongs to. */
  book: string;
  entries: GlossaryEntry[];
}

/**
 * WHERE A CLEANUP'S GLOSSARY LIVES — beside its records, named from the same
 * project key, so a cleanup and its triage find one glossary.
 */
export function glossaryPathsFor(request: FoundryJobRequest): { glossary: string; readings: string; book: string } {
  const named = request.kind === 'clean' ? request.recordsPath
    : request.kind === 'clean-triage' ? request.outputPath : undefined;
  if (typeof named !== 'string' || named.length === 0) {
    throw new Error(
      `A ${request.kind} request names no records or verdicts file, so there is nowhere to keep its `
      + 'narration glossary. The row was composed without the path Foundry gives every cleanup.',
    );
  }
  const dir = path.dirname(named);
  const base = path.basename(named);
  const cut = base.indexOf('.clean.');
  if (cut <= 0) {
    throw new Error(`${named} is not named <book>.clean.…, so the glossary cannot tell which book it is for.`);
  }
  const book = base.slice(0, cut);
  return {
    book,
    glossary: path.join(dir, `${book}.narration-glossary.json`),
    readings: path.join(dir, `${book}.narration-glossary.readings.json`),
  };
}

/**
 * The glossary file, or an empty one. A `narration-glossary/v1` file (the first
 * build, the same day) held one reading per form and no placings; it is a cache
 * of the model's answers and nothing a person wrote, so it is started afresh
 * rather than half-read.
 */
export function readGlossary(file: string, book: string): GlossaryFile {
  if (!fs.existsSync(file)) return { format: GLOSSARY_FORMAT, book, entries: [] };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as { format?: unknown; entries?: unknown };
  if (parsed.format === 'narration-glossary/v1') {
    const people = (parsed.entries as { by?: unknown }[] | undefined)?.some((e) => e.by === 'person') === true;
    if (people) {
      throw new Error(`${file} is a narration-glossary/v1 file holding a person's decisions, which this build cannot `
        + 'carry over by itself. Move them into a narration-glossary/v2 entry ("senses") and run again.');
    }
    return { format: GLOSSARY_FORMAT, book, entries: [] };
  }
  if (parsed.format !== GLOSSARY_FORMAT || !Array.isArray(parsed.entries)) {
    throw new Error(`${file} is not a ${GLOSSARY_FORMAT} file, so the glossary in it cannot be read. Nothing was asked.`);
  }
  return { format: GLOSSARY_FORMAT, book, entries: parsed.entries as GlossaryEntry[] };
}

function writeAtomically(file: string, body: unknown): void {
  const partial = `${file}.partial`;
  fs.writeFileSync(partial, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  fs.renameSync(partial, file);
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2: the meanings
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE PROMPT THAT MEASURED BEST (round five, 2026-10-03), with MEANINGS in place
 * of "depends". Every rule was bought by a wrong answer: the literal narrator
 * (kings "as printed"), roman numerals never as printed, acronyms never expanded
 * (SPD → "Social Democratic Party's"), no words beyond the form's own reading
 * ("Pope Pius the Ninth"). Two people with one name and number are one meaning
 * when they are said the same way.
 */
export const GLOSSARY_SYSTEM = [
  'You prepare a book for an audiobook. The narrator is a text-to-speech voice: it says EXACTLY what is printed, letter for letter. It does not know conventions. It reads "Henry IV" as "Henry I V", "Dr" as "D R", "e.g." as "E G". So everything a human reader would silently translate must be written out as the words to say.',
  '',
  'You decide how one printed form is said in this book. You are shown the form and sentences from across the book where it appears.',
  '',
  'Answer with one of two decisions:',
  '- "as-printed": saying it literally is right everywhere. This is for ordinary words, names, and acronyms (an acronym is read as its letters or as a word, exactly as printed). Give "senses" as an empty list.',
  '- "reading": somewhere the narrator must say something other than what is printed. List in "senses" each distinct MEANING the form has in these sentences — usually one. A form can mean two things in one book: "No." for number (said "Number") and "no" the word (said as printed) are two senses. Two different kings with the same name and number are ONE sense if both are said the same way.',
  '',
  'Senses differ only where they are SAID differently: a noun and an adjective use of the same thing are one sense.',
  '',
  'For each sense give:',
  '- "meaning": a few words naming it, enough to recognise it in a sentence.',
  '- "kind": "acronym" if the form is the initial letters of words, said as letters or as a word (NASA, a lower-case "ufo"); "abbreviation" if it shortens a word or phrase the narrator says in full (Dr, vols, approx.); "numeral" for a roman numeral; "word" for an ordinary word or name.',
  '- "reading": the words the narrator says for it, in ordinary spelling, or "" if that sense is said as printed.',
  '- "periodIsPart": true if, in this sense, a period right after the form belongs to it as an abbreviation\'s period ("approx." for approximately, "ed.", "Dr."); false if a period after it can only end the sentence (a word, a name, an acronym like NASA, a numeral).',
  '',
  'Rules for a reading:',
  '- A roman numeral is never as printed: a ruler\'s or pope\'s number is an ordinal ("Henry IV" → "Henry the Fourth"); a planet, part, act, volume, year or page is a cardinal ("Rigel VII" → "Rigel Seven", "Part II" → "Part Two"). Give the whole phrase as shown.',
  '- An abbreviation a reader expands is written as the word said ("Dr" → "Doctor", "vols" → "volumes").',
  '- An acronym or initialism is NEVER expanded into its full name: "FBI", "NASA", "SPD" are as printed, and an acronym printed in lower case is read as the acronym in capitals ("ufo" is said "UFO", not "unidentified flying object").',
  '- Never add words that are not the reading of the form itself, and never use digits.',
  '- Leave out a possessive "\'s": give the reading of the form alone.',
  '',
  'Use the book\'s sentences as your evidence: what the thing IS in this book decides how it is said. Give "why" in at most twenty words, naming that evidence.',
].join('\n');

const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'senses', 'why'],
  properties: {
    decision: { type: 'string', enum: ['as-printed', 'reading'] },
    senses: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['meaning', 'kind', 'reading', 'periodIsPart'],
        properties: {
          meaning: { type: 'string' },
          kind: { type: 'string', enum: ['acronym', 'abbreviation', 'numeral', 'word'] },
          reading: { type: 'string' },
          periodIsPart: { type: 'boolean' },
        },
      },
    },
    why: { type: 'string' },
  },
} as const;

/**
 * A SECOND LOOK: the sentences the decide door placed in NONE of the meanings the
 * first answer gave, and those meanings. Said to the model in so many words —
 * handed back as more samples, the same answer came back (2026-10-03: "St
 * Petersburg" fitted "Abbreviation for Saint" for nobody, and was asked again
 * as plain evidence, and placed nowhere again).
 */
export interface SecondLook {
  sentences: readonly string[];
  meanings: readonly GlossarySense[];
}

export function questionFor(form: PrintedForm, secondLook: SecondLook | null = null, focus: string | null = null): string {
  const printed = Object.keys(form.printed).map((p) => `"${p}"`).join(', ');
  const name = form.kind === 'roman' ? `"${form.key}"` : printed;
  const lines = form.samples.map((s, i) => `${i + 1}. ${s.sentence}`).join('\n');
  let question = `The form: ${name} — printed ${form.count} time${form.count === 1 ? '' : 's'} in this book.\n\n`
    + `Sentences from across the book:\n${lines}\n\n`;
  if (secondLook !== null) {
    question += 'You were asked this before, and gave these senses:\n'
      + secondLook.meanings.map((m) => `- ${m.meaning} (said ${m.reading.length > 0 ? `"${m.reading}"` : 'as printed'})`).join('\n')
      + '\n\nThese sentences from the book were judged to fit NONE of them:\n'
      + secondLook.sentences.map((s, i) => `${i + 1}. ${s}`).join('\n')
      + '\n\nGive the senses again so that every sentence above fits one: keep the ones that are right, and add or '
      + 'rename one for these. A sense can be the same reading under a wider meaning (a title that is also part '
      + 'of a place name, say).\n\n';
  }
  if (focus !== null) {
    question += `In every one of these sentences the form has ONE meaning: ${focus}. Give exactly one sense, for that `
      + 'meaning, and how the narrator says it.\n\n';
  }
  return question + (form.kind === 'roman' ? `A reading replaces the whole phrase "${form.key}".` : 'A reading replaces the form.');
}

/** The digest the meanings are filed under: a different question is asked again. */
export function questionDigest(form: PrintedForm, model: string): string {
  return createHash('sha256').update([
    GLOSSARY_PROMPT_VERSION, model, form.kind, form.key,
    ...Object.keys(form.printed).sort(), ...form.samples.map((s) => s.sentence),
  ].join('\u0000'), 'utf8').digest('hex');
}

export interface GlossaryAnswer { decision: 'as-printed' | 'reading'; senses: GlossarySense[]; why: string }

/** What a reply's text says, or what is wrong with it. */
export function parseAnswer(content: string): GlossaryAnswer | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return `the answer was not JSON (${content.slice(0, 80)})`;
  }
  const one = parsed as { decision?: unknown; senses?: unknown; why?: unknown };
  if ((one.decision !== 'as-printed' && one.decision !== 'reading') || !Array.isArray(one.senses) || typeof one.why !== 'string') {
    return `the answer did not have its three fields (${content.slice(0, 80)})`;
  }
  const senses: GlossarySense[] = [];
  for (const raw of one.senses as { meaning?: unknown; kind?: unknown; reading?: unknown; periodIsPart?: unknown }[]) {
    if (typeof raw?.meaning !== 'string' || typeof raw.reading !== 'string' || typeof raw.periodIsPart !== 'boolean'
      || !['acronym', 'abbreviation', 'numeral', 'word'].includes(raw.kind as string)) {
      return `a sense in the answer did not have its four fields (${content.slice(0, 80)})`;
    }
    senses.push({ meaning: raw.meaning.trim(), kind: raw.kind as SenseKind, reading: raw.reading.trim(), periodIsPart: raw.periodIsPart });
  }
  // A lower-case acronym's reading is its capitals, given by rule, so it may come back empty.
  if (one.decision === 'reading' && !senses.some((s) => s.reading.length > 0 || s.kind === 'acronym')) {
    return 'it chose a reading and gave none';
  }
  return { decision: one.decision, senses: one.decision === 'reading' ? senses : [], why: one.why.trim() };
}

/**
 * IS THIS MEANING'S READING ONE THE BOOK CAN BE GIVEN — or what is wrong with it.
 *
 * Detection only, never a reading: a meaning that fails keeps its place (its
 * occurrences are still placed, so they are not mistaken for another meaning)
 * and its spots stay as printed, for the sentence pass. The shapes are the ones
 * measured wrong: a reading that DROPS the word in front of a numeral ("Pius
 * IX" → "Pope the Ninth"), one that prints a digit, one that is the form again.
 */
export function senseProblem(form: PrintedForm, sense: GlossarySense): string | null {
  const reading = sense.reading;
  if (reading.length === 0) return null;
  if (/\d/.test(reading)) return `the reading "${reading}" prints a digit`;
  if (Object.keys(form.printed).includes(reading)) return `the reading "${reading}" is the form as printed`;
  if (form.kind === 'roman') {
    const words = form.key.split(' ');
    if (words.length === 2 && !reading.startsWith(`${words[0]} `)) {
      return `the reading "${reading}" does not keep "${words[0]}", the word in front of the numeral`;
    }
  }
  return null;
}

/**
 * AN ACRONYM IS SAID AS ITS CAPITALS. A form the model calls an acronym reads as
 * the form in capitals — as printed when it already is, "ESP" for "esp" — and a
 * period after it can only be the sentence's. The model decided WHAT it is; what
 * an acronym is said as is not a judgement.
 */
export function acronymRead(form: PrintedForm, sense: GlossarySense): GlossarySense {
  if (sense.kind !== 'acronym' || form.kind === 'roman') return sense;
  const capitals = form.key.replace(/\.$/, '').toUpperCase();
  const asPrinted = Object.keys(form.printed).every((p) => p.replace(/\.$/, '') === capitals);
  return { ...sense, reading: asPrinted ? '' : capitals, periodIsPart: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3: placing each occurrence
// ─────────────────────────────────────────────────────────────────────────────

/** Below this, a placing is not trusted and the spot is left to the sentence pass. */
export const PLACE_CONFIDENCE = 0.5;

/** The option a decide item answers when no listed meaning fits. */
const NONE = 'none';

/**
 * ── HOW A PLACING IS ASKED — the phrasing that measured, not the first one ──
 *
 * Measured 2026-10-03 on Hellworld's 23 "esp" (the psychic sense) and six
 * sentences using "esp." for especially, on the 27B: the occurrence marked
 * ⟦like this⟧ with "(said …)" after each meaning got 18/29 — "none" at 0.99 for
 * "Her esp kept trying to make sense of it". The PLAIN question — the sentence as
 * printed, the meanings by name, "something else" — got 29/29. So: plain. A
 * sentence printing the form twice names which one in words rather than marks.
 */
export function placingItem(occurrence: FormOccurrence): string {
  const s = occurrence.sentence;
  const times = s.split(occurrence.printed).length - 1;
  if (times <= 1) return `Sentence: ${s}`;
  const which = s.slice(0, occurrence.inSentence).split(occurrence.printed).length;
  const ordinal = ['first', 'second', 'third', 'fourth', 'fifth'][which - 1] ?? `number ${which}`;
  return `Sentence: ${s}\n(Asked about the ${ordinal} "${occurrence.printed}" in it.)`;
}

/** The decide door's options for a form: one per meaning, by name, and something else. */
export function placingOptions(senses: readonly GlossarySense[]): Record<string, string> {
  const options: Record<string, string> = {};
  senses.forEach((sense, i) => { options[`s${i}`] = sense.meaning; });
  options[NONE] = 'something else';
  return options;
}

export function placingState(form: PrintedForm): string {
  return `A book prints "${form.key}". It can mean different things. You will be shown sentences from the book.`;
}

export function placingInstructions(form: PrintedForm): string {
  return `What does "${form.key}" mean in this sentence?`;
}

/** The digest a placing is filed under: its meanings and its occurrences. */
/**
 * The digest a placing is filed under: the meanings BY NAME and the occurrences.
 * Not their readings — a placing asks which meaning, never how it is said, so a
 * reading decided after the placing (or corrected by a person) does not undo it.
 */
export function placingDigest(senses: readonly GlossarySense[], occurrences: readonly FormOccurrence[], model: string): string {
  return createHash('sha256').update(JSON.stringify([
    GLOSSARY_PROMPT_VERSION, model,
    senses.map((s) => s.meaning),
    occurrences.map((o) => [o.at, o.nth, o.printed, o.sentence, o.inSentence]),
  ]), 'utf8').digest('hex');
}

/** One decide answer: the option chosen and how sure. */
export interface PlacingAnswer { choice: string; confidence: number }

/**
 * Place every occurrence of one form among its meanings — injected so the keeper
 * drives the whole glossary with no server.
 */
export type GlossaryPlacer = (
  form: PrintedForm, senses: readonly GlossarySense[], occurrences: readonly FormOccurrence[],
) => Promise<PlacingAnswer[]>;

/** The occurrences one decide request carries: the shared state is primed once per request. */
const PLACE_BATCH = 40;

// ─────────────────────────────────────────────────────────────────────────────
// Step 5: the guide Foundry is handed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHAT ONE PLACED OCCURRENCE PRINTS. A spelling with no period is replaced by the
 * reading. One ending in a period ("esp.") depends on the meaning: where the
 * period is the abbreviation's, the reading consumes it — unless the occurrence
 * also ends its sentence, where the stop stays; where the period can only be the
 * sentence's (the psychic sense), it stays.
 */
export function spotReplace(occurrence: Pick<FormOccurrence, 'printed' | 'endsSentence'>, sense: GlossarySense): string {
  if (!occurrence.printed.endsWith('.')) return sense.reading;
  if (!sense.periodIsPart || occurrence.endsSentence) return `${sense.reading}.`;
  return sense.reading;
}

export interface SpotReading { find: string; replace: string; at: string; nth: number }

export function spotReadingsOf(entries: readonly GlossaryEntry[], forms: ReadonlyMap<string, PrintedForm>): SpotReading[] {
  const out: SpotReading[] = [];
  for (const entry of entries) {
    if (entry.decision !== 'reading') continue;
    const form = forms.get(`${entry.kind}\u0000${entry.key}`);
    if (form === undefined) continue;
    const where = new Map(form.occurrences.map((o) => [`${o.at}\u0000${o.printed}\u0000${o.nth}`, o] as const));
    for (const placed of entry.occurrences) {
      if (placed.sense === null) continue;
      const sense = entry.senses[placed.sense];
      if (sense === undefined || sense.reading.length === 0 || sense.problem !== undefined) continue;
      const occurrence = where.get(`${placed.at}\u0000${placed.printed}\u0000${placed.nth}`);
      if (occurrence === undefined) continue;
      const replace = spotReplace(occurrence, sense);
      if (replace === occurrence.printed) continue;
      out.push({ find: occurrence.printed, replace, at: occurrence.at, nth: occurrence.nth });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Asking
// ─────────────────────────────────────────────────────────────────────────────

/** One meanings question, answered — injected so the keeper drives the glossary with no server. */
export type GlossaryAsker = (
  form: PrintedForm, secondLook: SecondLook | null, focus: string | null,
) => Promise<GlossaryAnswer | string>;

/** Meanings questions in flight at once: the depth the measurement ran at. */
const GLOSSARY_DEPTH = 8;
/** Placing requests in flight at once. */
const PLACE_DEPTH = 4;

/**
 * WEATHER ON ONE REQUEST IS RETRIED, then waited on with a sentence. Four tries
 * over ~14 s; past it the row waits and asks again, and every decision already
 * made is in the file, so the resume asks only what is left.
 */
const WEATHER_TRIES = 4;
const WEATHER_BACKOFF_MS = [2_000, 4_000, 8_000];

function isWeather(err: unknown): boolean {
  if (err instanceof CrucibleUnreachable || err instanceof CrucibleBusy) return true;
  const status = (err as { status?: unknown })?.status;
  return typeof status === 'number' && (status === 502 || status === 503 || status === 504);
}

async function withWeather<T>(signal: AbortSignal, call: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call();
    } catch (err) {
      if (signal.aborted) throw err;
      if (!isWeather(err) || attempt >= WEATHER_TRIES) throw err;
      await new Promise((resolve) => setTimeout(resolve, WEATHER_BACKOFF_MS[attempt - 1] ?? 8_000));
    }
  }
}

function chatAsker(server: string, model: string, signal: AbortSignal): GlossaryAsker {
  return async (form, secondLook, focus) => {
    const client = await crucibleClientFor(server, CRUCIBLE_CLIENT_NAME);
    const reply = await withWeather(signal, () => client.chat({
      model,
      act: 'analysis',
      temperature: 0,
      maxTokens: 1500,
      thinking: false,
      messages: [
        { role: 'system', content: GLOSSARY_SYSTEM },
        { role: 'user', content: questionFor(form, secondLook, focus) },
      ],
      responseFormat: {
        type: 'json_schema',
        json_schema: { name: 'glossary_meanings', strict: true, schema: ANSWER_SCHEMA },
      },
      signal,
    }));
    if (reply.finishReason === 'length') return 'the answer was cut off before it finished';
    return parseAnswer(reply.content);
  };
}

function decidePlacer(server: string, model: string, signal: AbortSignal): GlossaryPlacer {
  return async (form, senses, occurrences) => {
    const client = await crucibleClientFor(server, CRUCIBLE_CLIENT_NAME);
    const options = placingOptions(senses);
    const state = placingState(form);
    const out: PlacingAnswer[] = [];
    for (let from = 0; from < occurrences.length; from += PLACE_BATCH) {
      const batch = occurrences.slice(from, from + PLACE_BATCH);
      const reply = await withWeather(signal, () => client.decideItems({
        model,
        state,
        instructions: placingInstructions(form),
        options,
        items: batch.map((o) => ({ text: placingItem(o) })),
        // A label outside the engine's top tokens answers over the letters it did return.
        missing: 'report',
      }, { act: 'analysis', signal }));
      for (const answer of reply.answers) out.push({ choice: answer.choice, confidence: answer.confidence });
    }
    return out;
  };
}

/** Run `work` over `items`, `depth` at a time. */
async function pool<T>(items: readonly T[], depth: number, signal: AbortSignal, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(depth, items.length) }, async () => {
    while (next < items.length) {
      if (signal.aborted) throw signal.reason;
      await work(items[next++]!);
    }
  }));
}

export interface GlossaryOutcome {
  /** The guide to hand the run, or null when nothing in the book is read differently. */
  readingsPath: string | null;
  /** How many forms the book prints. */
  forms: number;
  /** How many meanings questions were asked this time (0 when every one was already answered). */
  asked: number;
  /** How many occurrences were placed this time. */
  placed: number;
  /** How many spots the guide reads. */
  readings: number;
  /** Occurrences of a form with a reading that are left as printed, to their sentence: placed in no meaning, or in an unusable one. */
  unplaced: number;
}

export interface EnsureGlossaryOptions {
  request: FoundryJobRequest;
  /** The Crucible the cleanup was admitted to, by name. The glossary asks the same machine. */
  server: string;
  signal: AbortSignal;
  /** One line for the row and the log. */
  report: (line: string) => void;
  /** Foundry's lister (`foundryFormsLister()`); injected for the keeper. */
  listForms: FoundryFormsLister;
  /** Injected for the keeper; production chats. */
  ask?: GlossaryAsker;
  /** Injected for the keeper; production asks the decide door. */
  place?: GlossaryPlacer;
  /** The model's name, when the two are injected. Production asks the server. */
  model?: string;
}

/**
 * MAKE SURE THIS BOOK'S GUIDE ANSWERS EVERY FORM AND EVERY SPOT IT PRINTS, and
 * write the readings the run will be handed. Returns where they are.
 */
export async function ensureNarrationGlossary(opts: EnsureGlossaryOptions): Promise<GlossaryOutcome> {
  const { request, server, report, signal } = opts;
  const files = glossaryPathsFor(request);

  report('glossary: listing the book\'s printed forms');
  const listed = await opts.listForms(request) as { format?: unknown; forms?: unknown };
  if (listed?.format !== 'printed-forms/v1' || !Array.isArray(listed.forms)) {
    throw new Error('Foundry listed the book\'s printed forms in a shape this app does not read (expected printed-forms/v1).');
  }
  const forms = listed.forms as PrintedForm[];
  if (forms.some((f) => !Array.isArray(f.occurrences))) {
    throw new Error('Foundry listed the book\'s printed forms without their occurrences — a vendored Foundry older '
      + 'than the spot readings. Re-vendor foundry-app.');
  }
  /*
   * A BOOK THAT PRINTS NO FORM ASKS NOTHING, not even which model would answer —
   * and is handed nothing. A guide left from an earlier text is removed, because
   * what it would read is no longer printed.
   */
  if (forms.length === 0) {
    fs.rmSync(files.readings, { force: true });
    report('glossary: the book prints no form a narrator reads differently');
    return { readingsPath: null, forms: 0, asked: 0, placed: 0, readings: 0, unplaced: 0 };
  }

  // The model the server names for this class, unless the keeper named one.
  let model = opts.model;
  if (model === undefined) {
    const host = processTextVenueHost();
    model = modelFromCapability(await host.capability(server), 'analysis', server);
  }
  const formKey = (f: { kind: string; key: string }): string => `${f.kind}\u0000${f.key}`;
  const formsByKey = new Map(forms.map((f) => [formKey(f), f] as const));

  const glossary = readGlossary(files.glossary, files.book);
  const had = new Map(glossary.entries.map((e) => [formKey(e), e] as const));
  const listedKeys = new Set(forms.map(formKey));
  // A person's entry for a form the book no longer prints is kept in the file, unread.
  const orphans = glossary.entries.filter((e) => e.by === 'person' && !listedKeys.has(formKey(e)));

  // ── What needs asking ─────────────────────────────────────────────────────
  const entries = new Map<string, GlossaryEntry>();
  const toAsk: PrintedForm[] = [];
  for (const form of forms) {
    const before = had.get(formKey(form));
    if (before !== undefined && (before.by === 'person' || before.question === questionDigest(form, model))) {
      entries.set(formKey(form), { ...before, count: form.count, printed: form.printed });
    } else {
      toAsk.push(form);
    }
  }
  const toPlace = (): PrintedForm[] => forms.filter((form) => {
    const entry = entries.get(formKey(form));
    return entry !== undefined && entry.decision === 'reading'
      && entry.placed !== placingDigest(entry.senses, form.occurrences, model!);
  });

  const save = (): void => {
    const ordered = forms.map((f) => entries.get(formKey(f))).filter((e): e is GlossaryEntry => e !== undefined);
    writeAtomically(files.glossary, { ...glossary, entries: [...ordered, ...orphans] });
  };

  let asked = 0;
  let placedNow = 0;
  const needsModel = toAsk.length > 0 || toPlace().length > 0;
  if (needsModel) {
    report(`glossary: ${forms.length} printed form(s); asking ${model} on "${server}" about ${toAsk.length}`);
    let lease: CrucibleLease | null = null;
    try {
      // An upstream-routed class has no card to hold (text-acts.ts); a local one needs its turn.
      if (opts.ask === undefined && !isUpstreamModelId(model)) {
        try {
          lease = await takeCrucibleLease({
            server, kind: 'model', id: model, act: 'analysis', signal,
            onQueue: (line) => report(`glossary: ${line}`),
            onLog: (line) => console.log(`[GLOSSARY] ${line}`),
          });
        } catch (err) {
          throw asSessionWait(err, server, 'analysis');
        }
      }
      const ask = opts.ask ?? chatAsker(server, model, signal);
      const place = opts.place ?? decidePlacer(server, model, signal);
      const at = new Date().toISOString();

      const meaningsOf = async (form: PrintedForm, secondLook: SecondLook | null): Promise<GlossaryEntry> => {
        let answer: GlossaryAnswer | string;
        try {
          answer = await ask(form, secondLook, null);
        } catch (err) {
          throw weatherWait(err, server);
        }
        const base = {
          key: form.key, kind: form.kind, count: form.count, printed: form.printed,
          by: 'model' as const, model, question: questionDigest(form, model), occurrences: [], at,
        };
        if (typeof answer === 'string') {
          // An answer nobody can read leaves the form as printed — the sentence pass, as before.
          return { ...base, decision: 'as-printed', senses: [], why: `left to each sentence: ${answer}` };
        }
        const senses = answer.senses.map((given) => {
          const sense = acronymRead(form, given);
          const problem = senseProblem(form, sense);
          return problem === null ? sense : { ...sense, problem };
        });
        return { ...base, decision: answer.decision, senses, why: answer.why };
      };

      // ── Step 2: the meanings ──────────────────────────────────────────────
      let done = 0;
      await pool(toAsk, GLOSSARY_DEPTH, signal, async (form) => {
        entries.set(formKey(form), await meaningsOf(form, null));
        asked += 1;
        done += 1;
        report(`glossary: meanings ${done}/${toAsk.length}`);
        save();
      });

      // ── Steps 3 and 4: placing, with one second look ──────────────────────
      const placing = toPlace();
      const total = placing.reduce((n, f) => n + f.occurrences.length, 0);
      let placedSoFar = 0;
      const placeForm = async (form: PrintedForm, entry: GlossaryEntry): Promise<{ entry: GlossaryEntry; nowhere: string[] }> => {
        const people = new Map(entry.occurrences.filter((o) => o.byPerson === true)
          .map((o) => [`${o.at}\u0000${o.printed}\u0000${o.nth}`, o] as const));
        const open = form.occurrences.filter((o) => !people.has(`${o.at}\u0000${o.printed}\u0000${o.nth}`));
        let answers: PlacingAnswer[];
        try {
          answers = open.length === 0 ? [] : await place(form, entry.senses, open);
        } catch (err) {
          throw weatherWait(err, server);
        }
        if (answers.length !== open.length) {
          throw new Error(`The decide door answered ${answers.length} of ${open.length} occurrences of "${form.key}". `
            + 'Nothing was placed for it.');
        }
        const nowhere: string[] = [];
        const placed: PlacedOccurrence[] = form.occurrences.map((o) => {
          const person = people.get(`${o.at}\u0000${o.printed}\u0000${o.nth}`);
          if (person !== undefined) return person;
          const answer = answers[open.indexOf(o)]!;
          const index = /^s(\d+)$/.exec(answer.choice);
          const sense = index !== null && answer.confidence >= PLACE_CONFIDENCE ? Number(index[1]) : null;
          if (answer.choice === NONE && answer.confidence >= PLACE_CONFIDENCE) nowhere.push(o.sentence);
          return { at: o.at, nth: o.nth, printed: o.printed, sense, p: answer.confidence };
        });
        placedNow += open.length;
        placedSoFar += open.length;
        report(`glossary: placing ${Math.min(placedSoFar, total)}/${total} occurrence(s)`);
        return {
          entry: { ...entry, occurrences: placed, placed: placingDigest(entry.senses, form.occurrences, model!) },
          nowhere,
        };
      };
      await pool(placing, PLACE_DEPTH, signal, async (form) => {
        const first = await placeForm(form, entries.get(formKey(form))!);
        let entry = first.entry;
        /*
         * A MEANING THE SAMPLES MISSED. Occurrences the door placed confidently in
         * NONE of the meanings are evidence of another: the meanings are asked
         * again with those sentences, and the form placed again — once. A person's
         * meanings are theirs, so a form they decided is never re-asked.
         */
        if (first.nowhere.length > 0 && entry.by === 'model') {
          const again = await meaningsOf(form, { sentences: [...new Set(first.nowhere)].slice(0, 6), meanings: entry.senses });
          asked += 1;
          if (again.decision === 'reading') entry = (await placeForm(form, again)).entry;
          else entry = { ...again, why: `${again.why} (asked again: ${first.nowhere.length} occurrence(s) fitted no meaning)` };
        }
        /*
         * ── EACH MEANING'S READING, ASKED WITH ITS OWN SENTENCES ─────────────────
         *
         * Measured 2026-10-03: with one meaning, the 27B reads a form right ("esp"
         * → "ESP", "Wolf IV" → "Wolf Four"); asked to NAME two meanings and say both
         * in one answer, it expanded the psychic sense to "extrasensory perception",
         * then to "esper", and with thinking on read the planet "Wolf the Fourth".
         * So a form of several meanings is read meaning by meaning, once placed:
         * each is asked alone, shown only the sentences placed in it — the
         * one-meaning question the model answers well, with better evidence than
         * the first samples. A person's meanings are theirs and are not re-read.
         */
        if (entry.by === 'model' && entry.senses.length > 1) {
          const read: GlossarySense[] = [];
          for (const [i, sense] of entry.senses.entries()) {
            const mine = form.occurrences.filter((o) => entry.occurrences.some((p) => p.sense === i
              && p.at === o.at && p.printed === o.printed && p.nth === o.nth));
            if (mine.length === 0) { read.push(sense); continue; }
            const step = Math.max(1, Math.floor(mine.length / 6));
            const samples = mine.filter((_, k) => k % step === 0).slice(0, 6).map((o) => ({ parts: o.at, sentence: o.sentence }));
            let answer: GlossaryAnswer | string;
            try {
              answer = await ask({ ...form, count: mine.length, samples }, null, sense.meaning);
            } catch (err) {
              throw weatherWait(err, server);
            }
            asked += 1;
            if (typeof answer === 'string') {
              read.push({ ...sense, problem: `its own reading could not be asked: ${answer}` });
              continue;
            }
            const alone = answer.senses[0];
            const given: GlossarySense = alone === undefined
              ? { ...sense, kind: 'word', reading: '', periodIsPart: sense.periodIsPart }
              : { meaning: sense.meaning, kind: alone.kind, reading: alone.reading, periodIsPart: alone.periodIsPart };
            const settled = acronymRead(form, given);
            const problem = senseProblem(form, settled);
            read.push(problem === null ? settled : { ...settled, problem });
          }
          entry = { ...entry, senses: read };
        }
        entries.set(formKey(form), entry);
        save();
      });
    } finally {
      await lease?.release();
    }
  }
  save();

  // ── Step 5: the guide ─────────────────────────────────────────────────────
  const final = forms.map((f) => entries.get(formKey(f))!);
  const readings = spotReadingsOf(final, formsByKey);
  // Left to their sentence: placed in no meaning, or in one whose reading cannot be given to the book.
  const unplaced = final.filter((e) => e.decision === 'reading')
    .reduce((n, e) => n + e.occurrences.filter((o) => o.sense === null || e.senses[o.sense]?.problem !== undefined).length, 0);
  const outcome = { forms: forms.length, asked, placed: placedNow, readings: readings.length, unplaced };
  if (readings.length === 0) {
    fs.rmSync(files.readings, { force: true });
    report(`glossary: ${forms.length} printed form(s), none read differently from how it is printed`);
    return { readingsPath: null, ...outcome };
  }
  writeAtomically(files.readings, { format: FIXED_READINGS_FORMAT, readings });
  report(`glossary: ${readings.length} spot(s) read across ${final.filter((e) => e.decision === 'reading').length} form(s)`
    + `${unplaced > 0 ? `; ${unplaced} occurrence(s) left to their sentence` : ''}`
    + `${asked === 0 && placedNow === 0 ? ' (every decision already made)' : ''}`);
  return { readingsPath: files.readings, ...outcome };
}

/** Weather past its budget is the row's wait; anything else travels as it is. */
function weatherWait(err: unknown, server: string): unknown {
  if (!isWeather(err)) return err;
  const line = `glossary: crucible "${server}" did not answer after ${WEATHER_TRIES} tries `
    + `(${err instanceof Error ? err.message : String(err)}); the decisions made so far are kept`;
  return Object.assign(new Error(line), { transient: true as const, transientLine: line });
}
