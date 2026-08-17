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
 */
export async function writeAtomically(destination: string, bytes: Buffer): Promise<void> {
  const target = path.resolve(destination);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.writing`;
  await fsp.writeFile(temporary, bytes);
  await fsp.rename(temporary, target);
}
