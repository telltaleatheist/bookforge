/**
 * Reading JSON somebody else may have written.
 *
 * ── The failure this exists for ─────────────────────────────────────────────
 *
 * A project's catalogue came back "catalogue unreadable" and stayed that way.
 * The file was perfect JSON. What was wrong with it was three bytes nobody can
 * see: `EF BB BF`, a UTF-8 byte-order mark, put there by whatever tool had last
 * touched it — Notepad, PowerShell's `Out-File`, a sync client, a text editor
 * defaulting to "UTF-8 with BOM" as most Windows editors still do.
 *
 * `fs.readFile(file, 'utf8')` DECODES THE BOM RATHER THAN DROPPING IT. Node
 * hands back a string whose first character is `﻿`, `JSON.parse` sees a
 * character that is not `{`, and throws "Unexpected token". Every caller in this
 * app then does the honest thing with that failure and refuses the file — so a
 * book the user could see on their disk became a project that could not be
 * opened, could not be listed, and could not even be deleted through the app,
 * because the delete card is composed from the catalogue it could not read.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * EVERY JSON FILE THIS APP READS THAT A PERSON OR ANOTHER PROGRAM CAN WRITE goes
 * through here. That is all of them in practice: the project catalogue, the
 * engine's settings.json, the app's own preferences, the recents list, the
 * overlay and its undo ledger, a book's history. This app wrote most of them and
 * never emits a BOM — but "we wrote it" is not a property of a file on a disk
 * that syncs, gets edited, gets restored from a backup, or gets opened once in
 * Notepad to see what is in it.
 *
 * IT STRIPS ONE MARK AND NOTHING ELSE. Not whitespace, not comments, not
 * trailing commas, no repair of any kind: everything else that makes a file
 * unparseable is a file this app should refuse, loudly, the way it already does.
 * A BOM is different in kind — it is not a mistake in the content, it is an
 * encoding artefact that carries no meaning at all in a file the reader already
 * knows is UTF-8, and the whole of the standard's advice is to ignore it.
 */

/** The one character, spelled once. U+FEFF, ZERO WIDTH NO-BREAK SPACE. */
const BOM = '﻿';

/**
 * The text without its byte-order mark, if it had one.
 *
 * ONLY AT THE START, and only one. A `﻿` anywhere else in a JSON document
 * is inside a string literal, where it is a character somebody meant — a
 * zero-width no-break space in a book's title is a strange thing to have but it
 * is not this function's business — and a second one at the front is a file
 * built by concatenating two BOM'd files, which is broken in a way worth
 * refusing.
 */
export function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(BOM.length) : text;
}

/**
 * `JSON.parse`, for a file rather than for a string this app just built.
 *
 * It throws exactly what `JSON.parse` throws, deliberately: every caller already
 * catches and wraps that in a sentence naming its own file ("project.json is not
 * JSON (…)"), and those sentences are better than anything a shared helper could
 * write. What changes is only that the one unreadable-for-no-reason case stops
 * reaching them.
 */
export function readJson(text: string): unknown {
  return JSON.parse(stripBom(text));
}
