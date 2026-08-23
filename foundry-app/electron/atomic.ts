/**
 * atomic — write a file so that an interruption leaves the old one intact.
 *
 * One function, and it is here rather than in the module that used to hold it
 * because that module was `epub-writer.ts`, whose other half packed an unpacked
 * `working/` tree back into a container. The working tree is gone (docs/RENDERER.md
 * §7), the pack half went with it, and what was left is a general fact about
 * writing files that the book file and the ledger both depend on. Named for what
 * it does, so the next caller does not have to know what an EPUB is to find it.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

/**
 * Write the bytes somewhere, via a temp file in the same directory.
 *
 * A rename is atomic on one volume, so a write that is interrupted leaves the
 * previous file intact rather than a half-written one with the right name. The
 * temp file is beside the target and not in %TEMP% precisely so the rename
 * cannot become a cross-volume copy.
 *
 * ── THE RENAME RETRIES, AND THE INCIDENT THAT MADE IT DO SO ─────────────────
 *
 * On Windows a rename fails transiently while ANOTHER process holds either
 * file — an antivirus scanning the freshly-written temp, an indexer touching
 * the target — and the failure is EPERM/EBUSY/EACCES for a lock that is gone
 * milliseconds later. Measured, 2026-08-23 19:13: a translation landed, the
 * derived book was written whole to `….en.book.jsonl.writing`, the ONE rename
 * failed, and the caller's honest not-fatal handling left the STALE book in
 * place — which then refused at open with "what this book was made from has
 * changed", a true sentence about the wrong problem, three hours of GPU work
 * sitting complete under a `.writing` name nobody reads. A handful of retries
 * with short waits is the whole cure for that class; a lock that outlives
 * them is a real failure and still throws to the caller, who says so.
 *
 * DELETE-THEN-RENAME IS DELIBERATELY NOT THE FALLBACK: it would open a window
 * where a crash leaves NO file under the target's name, and "the old book or
 * the new one, never neither" is the entire promise of this module.
 */
export async function writeAtomically(destination: string, bytes: Buffer): Promise<void> {
  const target = path.resolve(destination);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.writing`;
  await fsp.writeFile(temporary, bytes);
  const transient = new Set(['EPERM', 'EBUSY', 'EACCES']);
  for (let wait = 50; ; wait *= 2) {
    try {
      await fsp.rename(temporary, target);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (!transient.has(code) || wait > 800) throw err;
      await new Promise((rest) => setTimeout(rest, wait));
    }
  }
}
