/**
 * DERIVED SENTENCE SETS — the denoised and voice-converted renderings of a
 * session's cached sentences, kept beside the raw set instead of thrown away.
 *
 * ── Why they are durable now (Owen's ruling, 2026-08-29) ────────────────────
 *
 * They used to be merge-and-delete: a scratch directory under [library]/tmp that
 * one assembly consumed and the assembly deleted. That was defensible when the
 * pass was minutes. With the current Orpheus models the denoise pass costs about
 * as much GPU wall-clock as the narration itself, and re-assembling a book is a
 * routine act — a chapter excluded, metadata corrected, a de-ring turned on. Under
 * merge-and-delete every one of those re-runs paid for the whole pass again.
 *
 * So a derived set is now an ARTIFACT OF THE SESSION, written as a sibling of the
 * raw set:
 *
 *   <processDir>/chapters/sentences/                  ← the raw cache, NEVER touched
 *   <processDir>/chapters/sentences-denoised/         ← this module's 'denoise' set
 *   <processDir>/chapters/sentences-rvc-<voiceId>/    ← this module's 'rvc' set
 *
 * ── A SET IS NAMED BY THE WHOLE CHAIN THAT MADE IT ──────────────────────────
 *
 * Since the user picks the ORDER of the two enhancement passes (Owen's ruling,
 * 2026-08-29), a set can be the product of two of them, and the two orders are
 * different audio. So the directory spells the chain left to right, in the order
 * it ran:
 *
 *   sentences-denoised-rvc-leah    raw → denoise → convert through leah
 *   sentences-rvc-leah-denoised    raw → convert through leah → denoise
 *
 * The one-pass names above are that same rule with a chain of length one, which
 * is why they did not change. What DID change is that a conversion of the
 * DENOISED sentences is no longer written to `sentences-rvc-<voice>`: that name
 * now means a conversion of the RAW ones, and the two are separate sets. They
 * have to be, or flipping the order in the dialog would re-derive an hour of GPU
 * every time — which is exactly the thrash the durable sets exist to end. (The
 * price is paid once: a `sentences-rvc-<voice>` written before this change was a
 * conversion of the denoised set, and the first run after it re-derives under
 * the new name.)
 *
 * Living INSIDE the session is the whole lifetime story: the caches that replace a
 * session (`cacheSessionToProject`'s per-language sweep, the CLI's
 * `pruneOldSessions`) delete the session directory whole, and the derived sets go
 * with it. Nothing has to remember to clean them up, and no set can outlive the
 * sentences it was derived from.
 *
 * ── The manifest is what makes reuse safe ───────────────────────────────────
 *
 * A derived set that is silently reused when it should not be is worse than one
 * that is always recomputed: it is an audiobook assembled from the wrong audio,
 * and nothing about the file says so. So every derived set carries a manifest
 * naming exactly what it was derived FROM and WITH, and reuse requires all of it
 * to still hold — otherwise the whole set is re-derived. There is no partial
 * refresh and no "close enough": a mismatch is re-derivation, logged with the
 * reason (NO FALLBACKS).
 *
 * THE GAP KNOB IS PART OF THE DENOISE PARAMS, and that is inherent rather than a
 * wart. Gap normalization must run on the RAW sentences and BEFORE denoise — it
 * detects e2a's artificial trailing pad by its EXACTLY-zero samples, and the
 * roformer turns those zeros into dithered near-zeros that no longer trim cleanly
 * (see denoise-bridge's `normalizeSentenceGaps`). So the gap is BAKED into the
 * denoised set, and changing it invalidates that set and re-derives it. An
 * assembly-time gap knob and a durable denoised set cannot both be free.
 *
 * ── Replacement is atomic ───────────────────────────────────────────────────
 *
 * Derivation writes into `<dir>.partial` and renames it over the old set once the
 * manifest is in it. A crash mid-derive therefore leaves a `.partial` nobody
 * reads, never a half-written set that looks complete — the reuse check would
 * have no way to tell the difference, because "how many files should be here" is
 * exactly what the manifest exists to say.
 *
 * ONE SET PER CHAIN PER SESSION. A parameter change REPLACES the set rather than
 * accumulating a variant beside it: the session's audio budget is the raw set
 * plus one set per chain the user has actually asked for, and a book is
 * gigabytes. What a chain IS, is the (kind, upstream-identity) pair the name
 * spells — so "convert the raw sentences" and "convert the denoised sentences"
 * are two chains and two sets, while "convert the raw sentences at a different
 * index rate" is the same chain and replaces it.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Which pass produced a set. The dir name and the manifest both carry it. */
export type DerivedKind = 'denoise' | 'rvc';

/** The manifest file, inside the derived dir. Dot-prefixed and non-audio, so
 *  every consumer that lists sentences by extension steps over it. */
export const DERIVED_MANIFEST_NAME = '.bookforge-derived.json';

/** One source file's identity: name plus size and mtime. */
export interface DerivedSourceFile {
  name: string;
  size: number;
  mtimeMs: number;
}

export interface DerivedManifest {
  /** Bumped when the SHAPE below changes; an older number reads as stale. */
  version: 1;
  kind: DerivedKind;
  createdAt: string;
  /**
   * Everything about HOW this set was produced that would change its audio —
   * the gap seconds and floor for a denoise, the voice and its conversion knobs
   * for an RVC pass. Compared key-by-key against the request; any difference is
   * staleness.
   */
  params: Record<string, unknown>;
  /** The directory this set was derived FROM, absolute at derivation time. */
  sourceDir: string;
  /** Every source file's identity at derivation time. */
  sourceFiles: DerivedSourceFile[];
  /**
   * When the source was ITSELF a derived set (an RVC pass over the denoised
   * sentences), the manifest of that set — so a change to the denoise params
   * invalidates the conversion built on top of it, not just the denoise.
   */
  upstream?: { kind: DerivedKind; params: Record<string, unknown> } | null;
  /** How many audio files this set holds. Must equal `sourceFiles.length`. */
  outputCount: number;
}

/** The sentence files of a directory, sorted, by the same rule every consumer
 *  uses: `{index}.flac` (or `.wav` on older sessions). */
export function listSentenceFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((n) => /\.(flac|wav)$/i.test(n)).sort();
}

/** Identity of every sentence file in `dir`, for the manifest and the check. */
export function fingerprintSentences(dir: string): DerivedSourceFile[] {
  return listSentenceFiles(dir).map((name) => {
    const st = fs.statSync(path.join(dir, name));
    return { name, size: st.size, mtimeMs: Math.round(st.mtimeMs) };
  });
}

/** How each kind names its directory. The dir sits beside `sentences/` and is
 *  read by a person looking at a session, so it reads as English. */
const DIR_LABEL: Readonly<Record<DerivedKind, string>> = {
  denoise: 'denoised',
  rvc: 'rvc',
};

/**
 * ONE PASS of a chain: which kind it was, and which variant within that kind.
 *
 * `key` names the variant — the RVC voice — and is absent for a denoise, of
 * which there is one per source rather than one per anything the user picked.
 */
export interface DerivedPass {
  readonly kind: DerivedKind;
  readonly key?: string;
}

/**
 * HOW LONG A CHAIN MAY BE.
 *
 * Two, because the manifest records exactly one level of `upstream` and a third
 * pass would therefore be built on a provenance record that cannot say what its
 * own source was derived from — the staleness check would pass over a set whose
 * grandparent had been re-derived. Two is also every chain the dialog can
 * express (a denoise and a conversion, in either order), so this is a guard on a
 * shape nothing produces rather than a limit anybody meets.
 */
export const MAX_DERIVED_CHAIN = 2;

/** What one pass contributes to the directory name. */
function passToken(pass: DerivedPass): string {
  const suffix = pass.key === undefined ? '' : `-${pass.key.replace(/[^A-Za-z0-9._-]+/g, '_')}`;
  return `${DIR_LABEL[pass.kind]}${suffix}`;
}

/**
 * Where the set produced by this whole chain lives — the chain spelled left to
 * right, in the order the passes ran.
 *
 * The name IS the identity: two chains that differ anywhere are two directories,
 * so neither can silently overwrite the other and neither has to be re-derived
 * because the user changed their mind about the order.
 */
export function derivedChainDir(processDir: string, chain: readonly DerivedPass[]): string {
  if (chain.length === 0) {
    throw new Error(
      'A derived sentence set was asked for with no passes in its chain, so there is nothing to '
      + 'name it after. This is a bug in the job that composed it.',
    );
  }
  if (chain.length > MAX_DERIVED_CHAIN) {
    throw new Error(
      `A chain of ${chain.length} enhancement passes was asked for, and a derived set records `
      + `only ${MAX_DERIVED_CHAIN}. Its provenance could not be checked, so the set is refused `
      + 'rather than written with a manifest that cannot say what it was made from.',
    );
  }
  return path.join(processDir, 'chapters', `sentences-${chain.map(passToken).join('-')}`);
}

/** Where a derived set of this kind lives when it was derived from the RAW
 *  sentences — the one-pass case of `derivedChainDir`. */
export function derivedSentencesDir(processDir: string, kind: DerivedKind, key?: string): string {
  return derivedChainDir(processDir, [key === undefined ? { kind } : { kind, key }]);
}

/**
 * THE PASS A SET OF THESE PARAMS REPRESENTS — read off the params rather than
 * carried beside them, so there is one answer and it cannot drift from the set.
 *
 * A conversion with no voice in its params is refused rather than named
 * something: the voice is what tells two conversions of one session apart, and a
 * set that could not be told apart from another would be reused as it.
 */
export function derivedPassOf(kind: DerivedKind, params: Record<string, unknown>): DerivedPass {
  if (kind !== 'rvc') return { kind };
  const voiceId = params['voiceId'];
  if (typeof voiceId !== 'string' || voiceId === '') {
    throw new Error(
      'A voice-conversion sentence set records no voice in its parameters, so it cannot be named '
      + 'or told apart from a conversion through another voice. This is a bug in the job that '
      + 'wrote it.',
    );
  }
  return { kind, key: voiceId };
}

/** The whole chain a manifest describes, raw-first: its upstream pass, if it had
 *  one, then its own. This is what a pass built ON this set extends. */
export function derivedChainOf(manifest: DerivedManifest): DerivedPass[] {
  const own = derivedPassOf(manifest.kind, manifest.params);
  const upstream = manifest.upstream ?? null;
  return upstream === null ? [own] : [derivedPassOf(upstream.kind, upstream.params), own];
}

/** The raw cached set — the one canonical sentence store, never written to. */
export function rawSentencesDir(processDir: string): string {
  return path.join(processDir, 'chapters', 'sentences');
}

/**
 * The manifest of a set on disk, or null when there is none this build can read.
 *
 * EXPORTED because a pass that derives from another pass's output has to ask the
 * SET what it was made of. Threading that through the step configs instead would
 * be a second copy of a fact the set already carries — and the copy is the one
 * that goes stale when the upstream is re-derived, which is precisely the case
 * the `upstream` record exists to catch.
 */
export function readDerivedManifest(dir: string): DerivedManifest | null {
  try {
    const text = fs.readFileSync(path.join(dir, DERIVED_MANIFEST_NAME), 'utf-8');
    const parsed = JSON.parse(text) as DerivedManifest;
    return parsed && parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

/** Stable key-by-key comparison. Values are the JSON scalars the params carry. */
function sameParams(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)) return false;
  }
  return true;
}

export interface DerivedRequest {
  /** Where the set would live. */
  dir: string;
  kind: DerivedKind;
  params: Record<string, unknown>;
  /** The directory it would be derived from. */
  sourceDir: string;
  /** The source's own manifest, when the source is itself a derived set. */
  upstream?: { kind: DerivedKind; params: Record<string, unknown> } | null;
}

export type DerivedVerdict =
  | { reusable: true; manifest: DerivedManifest }
  /** `reason` is printed verbatim into the job log — it must say WHY. */
  | { reusable: false; reason: string };

/**
 * May the set already on disk be assembled, or must it be re-derived?
 *
 * Every answer of "no" names its reason, because a re-derivation nobody can
 * explain looks exactly like the reuse feature not working.
 */
export function checkDerivedSentences(req: DerivedRequest): DerivedVerdict {
  if (!fs.existsSync(req.dir)) {
    return { reusable: false, reason: 'no set has been derived for this session yet' };
  }
  const manifest = readDerivedManifest(req.dir);
  if (!manifest) {
    return { reusable: false, reason: `${req.dir} carries no readable derivation manifest` };
  }
  if (manifest.kind !== req.kind) {
    return { reusable: false, reason: `the set on disk was produced by a "${manifest.kind}" pass, not "${req.kind}"` };
  }
  if (!sameParams(manifest.params, req.params)) {
    return {
      reusable: false,
      reason: 'the settings changed since it was derived — was '
        + `${JSON.stringify(manifest.params)}, now ${JSON.stringify(req.params)}`,
    };
  }
  const wantUpstream = req.upstream ?? null;
  const haveUpstream = manifest.upstream ?? null;
  if ((wantUpstream === null) !== (haveUpstream === null)) {
    return {
      reusable: false,
      reason: wantUpstream === null
        ? 'the set on disk was derived from an enhanced source and this run derives from the raw one'
        : 'the set on disk was derived from the raw sentences and this run derives from an enhanced source',
    };
  }
  if (wantUpstream && haveUpstream) {
    if (wantUpstream.kind !== haveUpstream.kind || !sameParams(haveUpstream.params, wantUpstream.params)) {
      return { reusable: false, reason: 'the pass it was derived from has itself been re-derived with different settings' };
    }
  }

  let sourceNow: DerivedSourceFile[];
  try {
    sourceNow = fingerprintSentences(req.sourceDir);
  } catch (err) {
    return { reusable: false, reason: `its source ${req.sourceDir} could not be read: ${(err as Error).message}` };
  }
  if (sourceNow.length !== manifest.sourceFiles.length) {
    return {
      reusable: false,
      reason: `the source holds ${sourceNow.length} sentences now and held ${manifest.sourceFiles.length} when it was derived`,
    };
  }
  const before = new Map(manifest.sourceFiles.map((f) => [f.name, f]));
  for (const f of sourceNow) {
    const was = before.get(f.name);
    if (!was) return { reusable: false, reason: `the source gained a sentence (${f.name}) since it was derived` };
    if (was.size !== f.size || was.mtimeMs !== f.mtimeMs) {
      return { reusable: false, reason: `a source sentence changed since it was derived (${f.name})` };
    }
  }

  let outputs: string[];
  try {
    outputs = listSentenceFiles(req.dir);
  } catch (err) {
    return { reusable: false, reason: `it could not be listed: ${(err as Error).message}` };
  }
  if (outputs.length !== manifest.outputCount) {
    return {
      reusable: false,
      reason: `it holds ${outputs.length} files and its manifest declares ${manifest.outputCount}`,
    };
  }
  if (outputs.length !== sourceNow.length) {
    return {
      reusable: false,
      reason: `it holds ${outputs.length} sentences and its source holds ${sourceNow.length}`,
    };
  }
  return { reusable: true, manifest };
}

/** The scratch directory a derivation writes into before it is committed. */
export function derivedPartialDir(dir: string): string {
  return `${dir}.partial`;
}

/** Clear any leftover `.partial` and hand back an empty one to write into. */
export function beginDerivedSentences(dir: string): string {
  const partial = derivedPartialDir(dir);
  fs.rmSync(partial, { recursive: true, force: true });
  fs.mkdirSync(partial, { recursive: true });
  return partial;
}

/**
 * Stamp the manifest into the finished `.partial` and swap it over the old set.
 *
 * The manifest goes in FIRST: the rename is the only moment at which the set
 * becomes visible under its real name, so a set that exists always has one.
 */
export function commitDerivedSentences(
  dir: string,
  req: DerivedRequest,
): DerivedManifest {
  const partial = derivedPartialDir(dir);
  const sourceFiles = fingerprintSentences(req.sourceDir);
  const outputs = listSentenceFiles(partial);
  if (outputs.length !== sourceFiles.length) {
    throw new Error(
      `Derived sentence set is incomplete: ${outputs.length} written for ${sourceFiles.length} `
      + `source sentences in ${req.sourceDir}. Refusing to publish it.`,
    );
  }
  const manifest: DerivedManifest = {
    version: 1,
    kind: req.kind,
    createdAt: new Date().toISOString(),
    params: req.params,
    sourceDir: req.sourceDir,
    sourceFiles,
    upstream: req.upstream ?? null,
    outputCount: outputs.length,
  };
  fs.writeFileSync(path.join(partial, DERIVED_MANIFEST_NAME), JSON.stringify(manifest, null, 2), 'utf-8');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(partial, dir);
  return manifest;
}

/** Drop a `.partial` a failed or cancelled derivation left behind. */
export function abandonDerivedSentences(dir: string): void {
  try {
    fs.rmSync(derivedPartialDir(dir), { recursive: true, force: true });
  } catch { /* best-effort: the next derivation clears it anyway */ }
}
