/**
 * A book that was never zipped: an EPUB's entries as real files, at their
 * archive-relative paths.
 *
 * This is the working copy's container. Editing one chapter of a 25 MB book
 * should write that chapter, not re-deflate the book, and a tree is what makes
 * that possible — but only if quire cannot tell the difference. So this reader
 * answers with exactly the strings {@link QuireZipReader} answers with for the
 * same book: forward slashes on every platform, relative to the root, files
 * only. Everything above it — the spine walk, the shells, the `quire://`
 * handler — is written against those names and does not know which container it
 * is talking to.
 *
 * Two things it deliberately does NOT do:
 *
 *  - It does not cache file contents. A zip read seeks and inflates; this one
 *    opens and reads. Both go to the disk every time, so a caller cannot get a
 *    stale answer out of one and a fresh one out of the other.
 *  - It does not look for a sibling `.epub` when the tree is not a book. A
 *    directory that cannot be read as an EPUB is a refusal naming the
 *    directory, never a quiet swap to some other file that happens to be there.
 */
import * as fsSync from 'fs';
import * as path from 'path';
import { quireFail } from '../errors';
import type { QuireEntrySource, QuireEntrySourceKind } from './entry-source';

export class QuireDirectoryReader implements QuireEntrySource {
  readonly kind: QuireEntrySourceKind = 'directory';

  /**
   * The root with every symlink already resolved, so the containment check below
   * compares real paths against a real path. Null until `open`.
   */
  private root: string | null = null;

  /**
   * The entry index, taken once by `open`. The ZIP reader reads its central
   * directory once for the same reason: a book must not change what it contains
   * between the spine walk and the last page being served.
   */
  private entries: Set<string> | null = null;

  constructor(readonly sourcePath: string) {}

  describe(): string {
    return `the exploded EPUB directory ${this.sourcePath}`;
  }

  open(): void {
    let stat: fsSync.Stats;
    try {
      stat = fsSync.statSync(this.sourcePath);
    } catch (err) {
      quireFail(
        'DIR_UNREADABLE',
        `${this.sourcePath} cannot be read as an exploded EPUB: ${(err as Error).message}`,
      );
    }
    if (!stat.isDirectory()) {
      quireFail(
        'DIR_NOT_A_DIRECTORY',
        `${this.sourcePath} was opened as an exploded EPUB directory but it is not a directory`,
      );
    }

    // realpath so that a root reached through a symlink or a junction — which is
    // how BookForge's own worktrees are laid out — still compares equal to the
    // paths readdir hands back from inside it.
    const root = fsSync.realpathSync(this.sourcePath);
    const entries = new Set<string>();
    this.index(root, '', entries);
    if (entries.size === 0) {
      quireFail(
        'DIR_EMPTY',
        `${this.sourcePath} holds no files, so it is not an exploded EPUB`,
      );
    }
    this.root = root;
    this.entries = entries;
  }

  close(): void {
    this.root = null;
    this.entries = null;
  }

  hasEntry(name: string): boolean {
    return this.entries !== null && this.entries.has(name);
  }

  entryNames(): string[] {
    return Array.from(this.assertOpen().entries);
  }

  async readEntry(name: string): Promise<Buffer> {
    const { root, entries } = this.assertOpen();

    // Containment is checked BEFORE membership, so that a name reaching out of
    // the book is refused as the escape it is rather than reported as an entry
    // the book happens not to have. The two are different faults and the caller
    // is owed the difference.
    const full = this.resolveWithin(root, name);
    if (!entries.has(name)) {
      // The same code the ZIP reader raises for the same fault: a caller that
      // handles a missing entry must not have to know which container it came
      // out of.
      quireFail('ZIP_ENTRY_MISSING', `${this.describe()} has no entry "${name}"`);
    }
    return fsSync.promises.readFile(full);
  }

  async readText(name: string): Promise<string> {
    return (await this.readEntry(name)).toString('utf8');
  }

  private assertOpen(): { root: string; entries: Set<string> } {
    if (this.root === null || this.entries === null) {
      quireFail('DIR_CLOSED', `${this.describe()} is closed`);
    }
    return { root: this.root, entries: this.entries };
  }

  /**
   * An entry name to an absolute path inside the root, or a refusal.
   *
   * `path.resolve` collapses `..` and swallows a drive-absolute or
   * root-absolute name whole, so the check is made on the RESULT: whatever the
   * name was written as, the file it points at has to be under the root.
   */
  private resolveWithin(root: string, name: string): string {
    const full = path.resolve(root, name);
    const relative = path.relative(root, full);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      quireFail(
        'DIR_ENTRY_ESCAPE',
        `entry "${name}" resolves to ${full}, which is outside ${root} — quire serves a book's `
        + 'own files and nothing else',
      );
    }
    return full;
  }

  /**
   * Walk the tree into `into`, depth first, naming every file by its path from
   * the root with `/` separators.
   *
   * The separator is not "normalized" after the fact — the names are BUILT from
   * directory entries joined with `/`, so a backslash can never get into one on
   * Windows in the first place.
   */
  private index(dir: string, prefix: string, into: Set<string>): void {
    let children: fsSync.Dirent[];
    try {
      children = fsSync.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      quireFail(
        'DIR_UNREADABLE',
        `${dir} cannot be listed while indexing ${this.sourcePath}: ${(err as Error).message}`,
      );
    }
    for (const child of children) {
      const entry = prefix ? `${prefix}/${child.name}` : child.name;
      const full = path.join(dir, child.name);
      if (child.isDirectory()) {
        this.index(full, entry, into);
        continue;
      }
      if (child.isFile()) {
        into.add(entry);
        continue;
      }
      // A symlink is a second name for a file that may not be in the book at
      // all, and following one would put the containment check above at the
      // mercy of whatever it points at. An exploded EPUB has no use for one, so
      // it is refused rather than resolved.
      quireFail(
        'DIR_ENTRY_NOT_A_FILE',
        `${full} is ${child.isSymbolicLink() ? 'a symbolic link' : 'neither a file nor a directory'}`
        + `, which an exploded EPUB may not contain`,
      );
    }
  }
}
