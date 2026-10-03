/**
 * THE NARRATION GLOSSARY — how this book says each of its printed forms, decided
 * ONCE for the whole book before the cleanup reads it (Owen, 2026-10-03).
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 *
 * The cleanup asks about one sentence at a time, and one sentence is often not
 * enough to know what a form IS. *Deathstalker: Hellworld* prints "esp" 26
 * times for a psychic sense; shown "touched the sphere with her esp." alone the
 * model read it "especial", and the book came out saying "ESP" once and
 * "especial" twice — and "Wolf the Fourth" for a planet everyone else calls
 * "Wolf Four". Owen: *"how did you know its pronounced wolf four?"* From the
 * book: it is scanned, orbited and landed on. The evidence is in the book, just
 * not in the sentence.
 *
 * ── What ────────────────────────────────────────────────────────────────────
 *
 *   1. COLLECT — Foundry lists the book's printed forms (`foundry clean-forms`:
 *      roman numerals WITH the word before them, runs of capitals, abbreviations),
 *      each with up to six sentences spread across the book. Code decides nothing.
 *   2. DECIDE — the model is asked about each form ONCE, with those sentences:
 *      a reading ("Wolf Four", "ESP"), as printed, or depends-on-the-sentence.
 *   3. APPLY — every reading becomes a fixed reading the cleanup and its triage
 *      are handed (`--fixed-readings`), so the whole book says it one way and the
 *      sentence pass never re-reads it. "Depends" is left to the sentence pass.
 *
 * ── Measured before it was built (2026-10-03, Hellworld + The Pursuit of Power) ──
 *
 * Owen: *"we'll test it. if it isnt going to work the way we expect, we wont
 * implement."* Five rounds over 184 forms:
 *
 *   - the clean's own 9B: unstable — "esp" was ESP, then "espionage", then ESP
 *     again as the prompt moved; about one ruler in eight left "as printed".
 *   - the 27B (the server's `analysis` model on both machines): Hellworld 3/3,
 *     every ruler right, 180 of 184 identical across two runs, ~2 minutes.
 *   - the decide verb first, chat only for readings: slower (it said "reading"
 *     for 120 of 184, so most forms paid twice) and it got "esp" wrong.
 *
 * So the model is the server's ANALYSIS class — the server names it (`GET
 * /v1/capability`), this file never does — one chat per form, and the prompt is
 * the one that measured best. The prompt's single most important sentence is
 * that the narrator reads LITERALLY: without it the model answers "as printed"
 * for every king, because a human narrator would read "Henry IV" correctly.
 *
 * ── Ownership ───────────────────────────────────────────────────────────────
 *
 * Owen: *"foundry is for written texts. bookforge extends foundry's
 * functionality into spoken text"* — and *"it should effectively be a part of
 * the cleaning logic"*. So the glossary is this app's, and Foundry knows only a
 * list of strings to read (`fixed-readings`) and how to list a book's forms. It
 * runs inside the cleanup's own queue step, before the engine is spawned; there
 * is no separate step for a person to see or forget.
 *
 * ── Cost, and what is never paid twice ──────────────────────────────────────
 *
 * Selective by construction: a whole history book is ~180 questions, a novel a
 * handful (Hellworld: 3). A decision is cached in the glossary file under the
 * exact question it answered (form, sentences, prompt version, model), so the
 * cleanup behind a triage asks nothing, and a re-clean asks only about forms
 * whose evidence changed. A decision a PERSON wrote is never asked again.
 *
 * ── It runs in its own session, and closes it before the engine starts ─────
 *
 * The analysis model is not the cleanup's model, so the two cannot share a
 * session. The glossary opens one, asks, and CLOSES it before Foundry opens the
 * cleanup's — a session left open here would hold the card against Foundry's own
 * (nothing from another client runs while one is open). Not `withCrucibleLease`:
 * inside a row scope that hands the session to the row instead of closing it.
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

export const GLOSSARY_FORMAT = 'narration-glossary/v1';
/** The prompt's version: a decision made under another prompt is a different question. */
export const GLOSSARY_PROMPT_VERSION = 'g1';
/** What Foundry reads (its src/clean/fixed-readings.ts). */
const FIXED_READINGS_FORMAT = 'fixed-readings/v1';

export type GlossaryDecision = 'reading' | 'as-printed' | 'depends';

/** One printed form, as Foundry lists it (`printed-forms/v1`). */
export interface PrintedForm {
  key: string;
  kind: 'roman' | 'caps' | 'abbreviation';
  count: number;
  printed: Record<string, number>;
  samples: { parts: string; sentence: string }[];
}

export interface GlossaryEntry {
  key: string;
  kind: PrintedForm['kind'];
  count: number;
  printed: Record<string, number>;
  decision: GlossaryDecision;
  /** The words printed in the form's place. '' unless `decision` is `reading`. */
  reading: string;
  /** The model's one sentence of evidence, or what was wrong with its answer. */
  why: string;
  /** Who decided. A PERSON's decision is never asked again and never overwritten. */
  by: 'model' | 'person';
  /** The model that answered (absent for a person's). */
  model?: string;
  /** The question's digest — form, sentences, prompt version, model. */
  question?: string;
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
 * project key, so a cleanup and its triage (whose verdicts sit in the same
 * `readings/` directory) find one glossary.
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

export function readGlossary(file: string, book: string): GlossaryFile {
  if (!fs.existsSync(file)) return { format: GLOSSARY_FORMAT, book, entries: [] };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as Partial<GlossaryFile>;
  if (parsed.format !== GLOSSARY_FORMAT || !Array.isArray(parsed.entries)) {
    throw new Error(`${file} is not a ${GLOSSARY_FORMAT} file, so the glossary in it cannot be read. Nothing was asked.`);
  }
  return { format: GLOSSARY_FORMAT, book, entries: parsed.entries };
}

function writeAtomically(file: string, body: unknown): void {
  const partial = `${file}.partial`;
  fs.writeFileSync(partial, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  fs.renameSync(partial, file);
}

// ─────────────────────────────────────────────────────────────────────────────
// The question
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE PROMPT THAT MEASURED BEST (round five, 2026-10-03). Every line of it was
 * bought by a wrong answer: the literal narrator (kings "as printed"), roman
 * numerals never as printed, acronyms never expanded (SPD → "Social Democratic
 * Party's"), no words beyond the form's own reading ("Pope Pius the Ninth"),
 * "depends" only when the SAYING differs (two Wilhelm Is are both "the First").
 * The examples are other books' forms, so a measurement still measures the model.
 */
export const GLOSSARY_SYSTEM = [
  'You prepare a book for an audiobook. The narrator is a text-to-speech voice: it says EXACTLY what is printed, letter for letter. It does not know conventions. It reads "Henry IV" as "Henry I V", "Dr" as "D R", "e.g." as "E G". So everything a human reader would silently translate must be written out as the words to say.',
  '',
  'You decide, ONCE FOR THE WHOLE BOOK, how one printed form is said. You are shown the form and sentences from across the book where it appears.',
  '',
  'Answer with one of three decisions:',
  '- "reading": the form must be replaced by the words the narrator should say. Give those words in "reading", in ordinary spelling. They replace the form everywhere in the book.',
  '- "as-printed": saying it literally is already right. This is for ordinary words, names, and acronyms (an acronym is read as its letters or as a word, exactly as printed).',
  '- "depends": the form is SAID differently in different sentences, so each sentence must be decided on its own. Two different people with the same name and number are not "depends" if both are said the same way.',
  '',
  'Rules for the reading:',
  '- A roman numeral is never "as-printed": a ruler\'s or pope\'s number is an ordinal ("Henry IV" → "Henry the Fourth"); a planet, part, act, volume, year or page is a cardinal ("Rigel VII" → "Rigel Seven", "Part II" → "Part Two"). Give the whole phrase as shown.',
  '- An abbreviation a reader expands is written as the word said ("Dr" → "Doctor", "vols" → "volumes").',
  '- An acronym or initialism in capitals is NOT expanded into its full name: "FBI", "NASA", "SPD" are "as-printed". Only lower-case or oddly printed letters that are really an acronym become the acronym in capitals.',
  '- Never add words that are not the reading of the form itself, and never use digits.',
  '- Leave out a possessive "\'s": give the reading of the form alone.',
  '',
  'Use the book\'s sentences as your evidence: what the thing IS in this book decides how it is said. Give "why" in at most twenty words, naming that evidence.',
].join('\n');

const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'reading', 'why'],
  properties: {
    decision: { type: 'string', enum: ['reading', 'as-printed', 'depends'] },
    reading: { type: 'string' },
    why: { type: 'string' },
  },
} as const;

export function questionFor(form: PrintedForm): string {
  const printed = Object.keys(form.printed).map((p) => `"${p}"`).join(', ');
  const name = form.kind === 'roman' ? `"${form.key}"` : printed;
  const lines = form.samples.map((s, i) => `${i + 1}. ${s.sentence}`).join('\n');
  return `The form: ${name} — printed ${form.count} time${form.count === 1 ? '' : 's'} in this book.\n\n`
    + `Sentences from across the book:\n${lines}\n\n`
    + `If the decision is "reading", give the words that replace ${form.kind === 'roman' ? `"${form.key}"` : 'the form'}. `
    + 'Otherwise give "reading" as an empty string.';
}

/** The digest a cached decision is filed under: a different question is asked again. */
export function questionDigest(form: PrintedForm, model: string): string {
  return createHash('sha256').update([
    GLOSSARY_PROMPT_VERSION, model, form.kind, form.key,
    ...Object.keys(form.printed).sort(), ...form.samples.map((s) => s.sentence),
  ].join('\u0000'), 'utf8').digest('hex');
}

export interface GlossaryAnswer { decision: GlossaryDecision; reading: string; why: string }

/**
 * IS THIS ANSWER ONE THE BOOK CAN BE GIVEN — or what is wrong with it.
 *
 * Detection only, never a reading: an answer that fails is recorded as
 * `depends`, which hands the form back to the sentence pass exactly as it was
 * before the glossary existed. The checks are the shapes measured wrong:
 * a reading that DROPS the word in front of a numeral ("Pius IX" → "Pope the
 * Ninth"), one that prints a digit, an empty reading, one that is the form again.
 */
export function answerProblem(form: PrintedForm, answer: GlossaryAnswer): string | null {
  if (answer.decision !== 'reading') return null;
  const reading = answer.reading.trim();
  if (reading.length === 0) return 'it chose a reading and gave none';
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

/** What a reply's text says, or what is wrong with it. */
export function parseAnswer(content: string): GlossaryAnswer | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return `the answer was not JSON (${content.slice(0, 80)})`;
  }
  const one = parsed as Partial<GlossaryAnswer>;
  if ((one.decision !== 'reading' && one.decision !== 'as-printed' && one.decision !== 'depends')
    || typeof one.reading !== 'string' || typeof one.why !== 'string') {
    return `the answer did not have the three fields (${content.slice(0, 80)})`;
  }
  return { decision: one.decision, reading: one.reading.trim(), why: one.why.trim() };
}

// ─────────────────────────────────────────────────────────────────────────────
// The readings Foundry is handed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE FINDS FOR ONE DECIDED FORM. A numeral's is its phrase ("Wolf IV"); a run
 * of capitals is itself. An abbreviation is every spelling the book prints, with
 * one rule about the period: where the book ALSO prints the form without one,
 * the bare spelling is the find and a following period stays the sentence's
 * ("her esp." → "her ESP."); where it is only ever printed with one ("ed."),
 * the period is the abbreviation's and the reading consumes it.
 */
export function findsFor(entry: Pick<GlossaryEntry, 'kind' | 'key' | 'printed'>): string[] {
  if (entry.kind !== 'abbreviation') return [entry.key];
  const spellings = Object.keys(entry.printed);
  const out = new Set<string>();
  for (const spelling of spellings) {
    const bare = spelling.replace(/\.$/, '');
    out.add(spelling.endsWith('.') && spellings.includes(bare) ? bare : spelling);
  }
  return [...out];
}

export function fixedReadingsOf(entries: readonly GlossaryEntry[]): { find: string; replace: string }[] {
  const out: { find: string; replace: string }[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.decision !== 'reading' || entry.reading.length === 0) continue;
    for (const find of findsFor(entry)) {
      if (seen.has(find) || find === entry.reading) continue;
      seen.add(find);
      out.push({ find, replace: entry.reading });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Asking
// ─────────────────────────────────────────────────────────────────────────────

/** One question, answered — injected so the keeper drives the whole glossary with no server. */
export type GlossaryAsker = (form: PrintedForm) => Promise<GlossaryAnswer | string>;

/** Questions in flight at once: the depth the measurement ran at. */
const GLOSSARY_DEPTH = 8;

/**
 * WEATHER ON ONE QUESTION IS RETRIED, then waited on with a sentence. The
 * budget is four tries over ~14 s; past it the row waits (`busyLine`) rather
 * than failing, and the decisions already made are in the file, so the resume
 * asks only what is left.
 */
const WEATHER_TRIES = 4;
const WEATHER_BACKOFF_MS = [2_000, 4_000, 8_000];

function isWeather(err: unknown): boolean {
  if (err instanceof CrucibleUnreachable || err instanceof CrucibleBusy) return true;
  const status = (err as { status?: unknown })?.status;
  return typeof status === 'number' && (status === 502 || status === 503 || status === 504);
}

function chatAsker(server: string, model: string, signal: AbortSignal): GlossaryAsker {
  return async (form) => {
    const client = await crucibleClientFor(server, CRUCIBLE_CLIENT_NAME);
    for (let attempt = 1; ; attempt += 1) {
      try {
        const reply = await client.chat({
          model,
          act: 'analysis',
          temperature: 0,
          maxTokens: 1000,
          thinking: false,
          messages: [
            { role: 'system', content: GLOSSARY_SYSTEM },
            { role: 'user', content: questionFor(form) },
          ],
          responseFormat: {
            type: 'json_schema',
            json_schema: { name: 'glossary_decision', strict: true, schema: ANSWER_SCHEMA },
          },
          signal,
        });
        if (reply.finishReason === 'length') return 'the answer was cut off before it finished';
        return parseAnswer(reply.content);
      } catch (err) {
        if (signal.aborted) throw err;
        if (!isWeather(err) || attempt >= WEATHER_TRIES) throw err;
        await new Promise((resolve) => setTimeout(resolve, WEATHER_BACKOFF_MS[attempt - 1] ?? 8_000));
      }
    }
  };
}

export interface GlossaryOutcome {
  /** The readings file to hand the run, or null when the book has no reading to fix. */
  readingsPath: string | null;
  /** How many forms the book prints. */
  forms: number;
  /** How many were asked this time (0 when every decision was already made). */
  asked: number;
  /** How many readings the run is handed. */
  readings: number;
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
  /** Injected for the keeper; production opens a session and chats. */
  ask?: GlossaryAsker;
  /** The model's name, when `ask` is injected. Production asks the server. */
  model?: string;
}

/**
 * MAKE SURE THIS BOOK'S GLOSSARY ANSWERS EVERY FORM IT PRINTS, and write the
 * readings the run will be handed. Returns where they are.
 */
export async function ensureNarrationGlossary(opts: EnsureGlossaryOptions): Promise<GlossaryOutcome> {
  const { request, server, report } = opts;
  const files = glossaryPathsFor(request);

  report('glossary: listing the book\'s printed forms');
  const listed = await opts.listForms(request) as { format?: unknown; forms?: unknown };
  if (listed?.format !== 'printed-forms/v1' || !Array.isArray(listed.forms)) {
    throw new Error('Foundry listed the book\'s printed forms in a shape this app does not read (expected printed-forms/v1).');
  }
  const forms = listed.forms as PrintedForm[];
  /*
   * A BOOK THAT PRINTS NO FORM ASKS NOTHING, not even which model would answer —
   * and is handed nothing. A readings file left from an earlier text is removed,
   * because what it would fix is no longer printed.
   */
  if (forms.length === 0) {
    fs.rmSync(files.readings, { force: true });
    report('glossary: the book prints no form a narrator reads differently');
    return { readingsPath: null, forms: 0, asked: 0, readings: 0 };
  }

  // The model the server names for this class, unless the keeper named one.
  let model = opts.model;
  if (model === undefined) {
    const host = processTextVenueHost();
    model = modelFromCapability(await host.capability(server), 'analysis', server);
  }

  const glossary = readGlossary(files.glossary, files.book);
  const byKey = new Map(glossary.entries.map((e) => [`${e.kind}\u0000${e.key}`, e] as const));
  const toAsk: PrintedForm[] = [];
  const kept: GlossaryEntry[] = [];
  for (const form of forms) {
    const had = byKey.get(`${form.kind}\u0000${form.key}`);
    if (had?.by === 'person') {
      kept.push({ ...had, count: form.count, printed: form.printed });
      continue;
    }
    if (had !== undefined && had.question === questionDigest(form, model)) {
      kept.push(had);
      continue;
    }
    toAsk.push(form);
  }
  /*
   * A PERSON'S DECISION ABOUT A FORM THE BOOK NO LONGER PRINTS IS KEPT IN THE
   * FILE — it is their work, and an edit that brought the form back would want
   * it — but it is not handed to the run, because there is nothing for it to read.
   */
  const listedKeys = new Set(forms.map((f) => `${f.kind}\u0000${f.key}`));
  const orphans = glossary.entries.filter((e) => e.by === 'person' && !listedKeys.has(`${e.kind}\u0000${e.key}`));

  const fresh: GlossaryEntry[] = [];
  if (toAsk.length > 0) {
    report(`glossary: ${forms.length} printed form(s); asking ${model} on "${server}" about ${toAsk.length}`);
    let lease: CrucibleLease | null = null;
    try {
      // An upstream-routed class has no card to hold (text-acts.ts); a local one needs its turn.
      if (opts.ask === undefined && !isUpstreamModelId(model)) {
        try {
          lease = await takeCrucibleLease({
            server, kind: 'model', id: model, act: 'analysis', signal: opts.signal,
            onQueue: (line) => report(`glossary: ${line}`),
            onLog: (line) => console.log(`[GLOSSARY] ${line}`),
          });
        } catch (err) {
          throw asSessionWait(err, server, 'analysis');
        }
      }
      const ask = opts.ask ?? chatAsker(server, model, opts.signal);
      let next = 0;
      let done = 0;
      const at = new Date().toISOString();
      await Promise.all(Array.from({ length: Math.min(GLOSSARY_DEPTH, toAsk.length) }, async () => {
        while (next < toAsk.length) {
          if (opts.signal.aborted) throw opts.signal.reason;
          const form = toAsk[next++]!;
          let answer: GlossaryAnswer | string;
          try {
            answer = await ask(form);
          } catch (err) {
            if (isWeather(err)) {
              const line = `glossary: crucible "${server}" did not answer after ${WEATHER_TRIES} tries `
                + `(${err instanceof Error ? err.message : String(err)}); the decisions made so far are kept`;
              // Weather past its budget: the row waits and asks again (`transientLineOf`).
              throw Object.assign(new Error(line), { transient: true as const, transientLine: line });
            }
            throw err;
          }
          const problem = typeof answer === 'string' ? answer : answerProblem(form, answer);
          const entry: GlossaryEntry = {
            key: form.key, kind: form.kind, count: form.count, printed: form.printed,
            ...(problem === null && typeof answer !== 'string'
              ? { decision: answer.decision, reading: answer.decision === 'reading' ? answer.reading : '', why: answer.why }
              : { decision: 'depends' as const, reading: '', why: `left to each sentence: ${problem}` }),
            by: 'model', model, question: questionDigest(form, model), at,
          };
          fresh.push(entry);
          done += 1;
          report(`glossary: ${done}/${toAsk.length}`);
          // Written as each lands, so a stop or a wait keeps what it paid for.
          writeAtomically(files.glossary, { ...glossary, entries: [...kept, ...fresh, ...orphans] });
        }
      }));
    } finally {
      await lease?.release();
    }
  }

  // The book's order, so the file reads alongside the forms list.
  const order = new Map(forms.map((f, i) => [`${f.kind}\u0000${f.key}`, i] as const));
  const entries = [...kept, ...fresh]
    .sort((a, b) => order.get(`${a.kind}\u0000${a.key}`)! - order.get(`${b.kind}\u0000${b.key}`)!);
  writeAtomically(files.glossary, { ...glossary, entries: [...entries, ...orphans] });

  const readings = fixedReadingsOf(entries);
  if (readings.length === 0) {
    fs.rmSync(files.readings, { force: true });
    report(`glossary: ${forms.length} printed form(s), none read differently from how it is printed`);
    return { readingsPath: null, forms: forms.length, asked: toAsk.length, readings: 0 };
  }
  writeAtomically(files.readings, { format: FIXED_READINGS_FORMAT, readings });
  const depends = entries.filter((e) => e.decision === 'depends').length;
  report(`glossary: ${readings.length} reading(s) fixed for the whole book`
    + `${depends > 0 ? `; ${depends} form(s) left to each sentence` : ''}`
    + `${toAsk.length === 0 ? ' (every decision already made)' : ''}`);
  return { readingsPath: files.readings, forms: forms.length, asked: toAsk.length, readings: readings.length };
}
