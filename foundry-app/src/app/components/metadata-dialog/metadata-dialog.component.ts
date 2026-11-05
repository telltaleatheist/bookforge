import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { qualify } from '@owen/foundry-core/shared/documents';
import { fold } from '@owen/foundry-core/shared/original';
import type { DocumentMetadata, StepLedgerView } from '@owen/foundry-core/shared/types';

import { LedgerService } from '../../core/ledger.service';
import { ProjectsService } from '../../core/projects.service';
import { isExportView, OpenDocumentsService, type Tab } from '../../core/documents.service';
import { PositionSyncService } from '../../core/position-sync.service';
import { StageService } from '../../core/stage.service';
import { UiService } from '../../core/ui.service';
import { api } from '../../core/foundry';

/**
 * Metadata — the record the DOCUMENT keeps about itself.
 *
 * The same shape as the OCR and Translate dialogs, and one important difference:
 * those two configure a job and hand it to the queue, while this one reads and
 * writes a file directly. It is still an engine command — `foundry epub-meta`
 * and `foundry pdf-meta`, spawned by main and answered as JSON on stdout — but
 * it finishes in milliseconds, so there is nothing to queue and nothing to
 * watch.
 *
 * FILENAMES DO NOT FOLLOW THE TITLE, and this is the comment for whoever comes
 * along later and thinks that looks like an oversight. `project.json` holds
 * `title` and `stem` as two fields precisely so that a book's NAME and its
 * FILENAMES are decoupled by construction. Correcting a title changes the
 * metadata and moves nothing: those paths are in the user's recents, in
 * whatever else they have pointed at them, and in a sync client's index, and a
 * settings-shaped gesture that quietly renamed a 20 MB file in three places is
 * not a thing this app does behind somebody's back. "Rename the files to match"
 * can exist later as its own deliberate action, with its own button.
 *
 * WHAT IS EDITED IS A COPY THIS APP MADE, never one it was given. For a PDF that
 * is the working PDF, which the engine rewrites whole; `archive/` still holds the
 * file that came in, byte for byte, which is what makes that acceptable. For a
 * book it is a FINISHED EXPORT in `<project>/final/` — the container this app
 * cast out of the bank and can cast again — reached through the tray rather than
 * through the opened-documents allow-list, because an export was never opened.
 * There is no third case: an EPUB somebody imported is read into a bank and this
 * dialog never points at it.
 *
 * AND EVERY WRITE LANDS TWICE. The document changes, which is what the person
 * sees, and a metadata step is recorded, which is what a book made three weeks
 * later out of a bank that never knew the title was corrected will carry
 * (`MetadataPatch`, shared/types.ts). The second half is the one that matters for
 * an export, because the next export is a fresh cast rather than an edit of this
 * one.
 *
 * ONLY WHAT CHANGED IS SENT. A field the user did not touch is not in the patch
 * and is not on the engine's command line, so it is not re-spliced, not
 * renormalised, and not turned into a refusal about blank values by a box that
 * happened to be empty.
 */
@Component({
  selector: 'app-metadata-dialog',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './metadata-dialog.component.html',
  styleUrl: './metadata-dialog.component.scss',
})
export class MetadataDialogComponent {
  protected readonly ui = inject(UiService);
  private readonly documents = inject(OpenDocumentsService);
  private readonly stage = inject(StageService);
  private readonly positions = inject(PositionSyncService);
  private readonly projects = inject(ProjectsService);
  /**
   * The steps accordion's mirror — held here so that a save can hand it the
   * history main just wrote.
   *
   * DIRECTLY, AND NOT THROUGH THE TABS SERVICE. The commit path goes through
   * `OpenDocumentsService` because that side is holding the document's path; this dialog
   * already resolves its own document out of the position (`source` below), so a
   * second hop would be a message passed through a class that has nothing to add
   * to it. `adopt` is the public door and it is the same door the commit uses.
   */
  private readonly ledger = inject(LedgerService);

  /**
   * The document this record belongs to — THE ONE THE POSITION IS SHOWING, in a
   * project.
   *
   * ── One selection, and this dialog was one of the two ───────────────────────
   *
   * It was "the focused pane's document", which is the tab keying that
   * docs/WORKBENCH.md §6c retired: *"every action keys off the position, never the
   * open tab."* A project holds a scan and the book cast from it, the six fields
   * are a `dc:` package for one and an Info dictionary for the other, and which of
   * them you were editing used to depend on which pane you last clicked in rather
   * than on where you were standing. Standing on the import edits the scan's
   * record; standing on the book — or on any save above it — edits the book's.
   *
   * IT ANSWERS A TAB AND NOT A PATH, because writing a record is not the only
   * thing this dialog does with it: the name in the field is the tab's, and the
   * write has to reach the document the app has OPEN so the pane re-reads it. The
   * position's document is matched against the open tabs by whole path, folded —
   * never by last segment, because a project holds `archive/`, `working/` and
   * `generated/` copies of one book at once.
   *
   * WITH A FALLBACK TO THE FOCUSED TAB, for the gap where the position has no
   * document of its own or has not resolved one yet (a project nothing has read a
   * history for, a book still being cast). The alternative is an empty dialog over
   * a document that is plainly on screen, which is the app refusing to do
   * something it can obviously do.
   *
   * A LOOSE FILE IS UNCHANGED: no project, no ledger, no position — its actions go
   * on taking the file.
   *
   * ── AN EXPORT SHORT-CIRCUITS ALL OF THAT, BECAUSE IT IS NOT A POSITION ─────
   *
   * Everything below is the answer to "which of this project's documents is the
   * position showing", and a finished export is not one of them: it is a file this
   * app filed, out of a bank, at a step somebody may have walked away from since.
   * Running it through the resolution would hand back the project's PDF — the
   * dialog would open on an export and edit a scan, silently, which is precisely
   * the class of mistake the position keying exists to prevent. The tab IS the
   * document here, and the tab is the answer.
   */
  protected readonly source = computed(() => {
    const tab = this.stage.activeDocument();
    if (tab === null) return null;
    if (isExportView(tab)) return tab;
    const mine = tab.kind === 'pdf' ? tab : null;
    const project = this.projects.projectFor(tab.path);
    if (project === null) return mine;
    const shown = this.positions.documentShownFor(project.dir);
    if (shown === null) return mine;
    const at = fold(shown);
    return this.documents.tabs().find(
      (candidate) => candidate.kind === 'pdf' && fold(candidate.path) === at) ?? mine;
  });

  /**
   * The document, named and qualified — "Working Towards the Führer · PDF".
   *
   * BOTH HALVES EARN THEIR PLACE. The name is the tab's, so this card agrees
   * with the pane behind it and with the list on the left. The kind is what
   * stops the field being ambiguous in the one case that matters here: a project
   * holds a scan and a book cast from it, this dialog opens on whichever is
   * focused, and the six fields it shows are a `dc:` package for one and an Info
   * dictionary for the other. Somebody who cannot tell which they are editing
   * cannot read the form.
   *
   * SO IT IS THE TAB'S OWN KIND AND NOT A CONSTANT. It was hard-coded to `pdf` for
   * as long as a scan was the only thing that reached this dialog, and a card
   * reading "Working Towards the Führer · PDF" over six `dc:` boxes would be the
   * one field whose whole job is to disambiguate, saying the wrong thing.
   */
  protected named(tab: Tab): string {
    return qualify(tab.title, isExportView(tab) ? 'epub' : 'pdf', '');
  }

  /** What the document said when the dialog opened. The baseline every save diffs against. */
  protected readonly record = signal<DocumentMetadata | null>(null);
  protected readonly loading = signal(false);
  protected readonly busy = signal(false);
  protected readonly problem = signal<string | null>(null);

  /*
   * SIX BOXES FOR TWO FORMATS, and the overlap is not a coincidence: a title is
   * a title in both, and an EPUB's `dc:creator` and a PDF's `/Author` are the
   * same fact spelled twice. The three that exist in only one format get their
   * own signals rather than being crammed into the shared ones, because a value
   * carried across a format switch would be a value nobody typed.
   */
  protected readonly title = signal('');
  protected readonly creator = signal('');
  protected readonly language = signal('');
  protected readonly publisher = signal('');
  protected readonly date = signal('');
  protected readonly identifier = signal('');
  protected readonly subject = signal('');
  protected readonly keywords = signal('');

  constructor() {
    // The document decides what is in the boxes, and changing documents reloads
    // them from the new one. Nothing is carried over: an unsaved edit to one
    // book's title is not an opinion about another book's.
    effect(() => {
      const tab = this.source();
      this.problem.set(null);
      this.record.set(null);
      if (tab === null) return;
      void this.load();
    });
  }

  /** How many elements a field has, when the package has more than one of them. */
  protected doubled(field: string): boolean {
    const meta = this.record();
    return meta !== null && meta.kind === 'epub' && (meta.counts[field] ?? 0) > 1;
  }

  /** The fields this package declares twice, named, or null when there are none. */
  protected readonly doubledFields = computed(() => {
    const meta = this.record();
    if (meta === null || meta.kind !== 'epub') return null;
    const many = Object.entries(meta.counts)
      .filter(([, count]) => count > 1)
      .map(([field]) => `dc:${field}`);
    return many.length === 0 ? null : many.join(' and ');
  });

  /**
   * What the Identifier box says about itself.
   *
   * The identifier is the one field that is a POINTER as well as a value:
   * `<package unique-identifier>` names it by id, and that link is what a
   * catalogue, an annotation store and a sync service all key on. Where the
   * link is broken the engine refuses to write rather than guessing which
   * identifier was meant, so the box says so instead of failing on Save.
   */
  protected readonly identifierNote = computed(() => {
    const meta = this.record();
    if (meta === null || meta.kind !== 'epub') return '';
    return meta.uniqueIdentifier === null
      ? 'the package names none — not editable'
      : `#${meta.uniqueIdentifier}`;
  });

  protected openDocument(): void {
    void this.documents.openViaDialog();
  }

  private async load(): Promise<void> {
    const tab = this.source();
    if (tab === null || !api) return;
    this.loading.set(true);
    this.problem.set(null);
    try {
      /*
       * WHICH COMMAND IS DECIDED BY THE TAB, and the ANSWER decides which form is
       * drawn. Those are two different questions and they are deliberately not
       * collapsed into one: `record().kind` is what the engine said the document
       * is, so a package read out of a file this app thought was one and is not
       * paints as what it turned out to be rather than as what was expected.
       */
      const outcome = isExportView(tab)
        ? await api.meta.readEpub(tab.path)
        : await api.meta.readPdf(tab.path);
      if (outcome === null) {
        this.problem.set('This book is still opening — its package has not been read yet.');
        return;
      }
      if (!outcome.ok) {
        // The engine's own sentence, never paraphrased. Its refusals name the
        // file and say which half is missing, and a summary of that would be
        // strictly less useful than the thing itself.
        this.problem.set(outcome.reason);
        return;
      }
      this.fill(outcome.metadata);
    } catch (err) {
      this.problem.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.loading.set(false);
    }
  }

  /** Put the document's answers in the boxes. An absent field is an empty box. */
  private fill(meta: DocumentMetadata): void {
    this.record.set(meta);
    if (meta.kind === 'epub') {
      this.title.set(meta.fields.title ?? '');
      this.creator.set(meta.fields.creator ?? '');
      this.language.set(meta.fields.language ?? '');
      this.publisher.set(meta.fields.publisher ?? '');
      this.date.set(meta.fields.date ?? '');
      this.identifier.set(meta.fields.identifier ?? '');
      return;
    }
    this.title.set(meta.fields.title ?? '');
    this.creator.set(meta.fields.author ?? '');
    this.subject.set(meta.fields.subject ?? '');
    this.keywords.set(meta.fields.keywords ?? '');
  }

  /**
   * One field of the patch, or nothing.
   *
   * A box the user did not touch is left OUT of the patch entirely, and so is
   * one they emptied. Emptying a box is not an instruction to blank the field —
   * the engine refuses a blank value by name for exactly the reason a person
   * would want it to, since `dc:title` is required and an empty `dc:creator` is
   * a claim that the book's author is called nothing — and treating a cleared
   * box as a clear command would turn a stray backspace into a refusal on Save.
   * Removing a field is a thing to add deliberately if it is ever wanted.
   */
  private changedField(value: string, was: string | null): string | undefined {
    const trimmed = value.trim();
    if (trimmed.length === 0) return undefined;
    return trimmed === (was ?? '') ? undefined : trimmed;
  }

  /**
   * The history main just wrote, put where the accordion reads it.
   *
   * ── One answer, painted whole ───────────────────────────────────────────────
   *
   * An Apply mints a step, and the ROWS are main's to compose — the chronological
   * order and the quiet "from …" annotation are the one concession this design
   * makes to the tree, and a renderer deriving them would be a second
   * implementation of the rule that decides whether the flat list misleads. So the
   * write hands back both halves and this paints them, exactly as a curation
   * commit does. Asking again afterwards would leave the accordion a turn behind
   * its own new row.
   *
   * ABSENT IS ORDINARY AND MEANS NOTHING WAS MINTED: a loose file the user opened
   * off their own disk has no project to file a step in, and a patch with no
   * changed fields is a read that happened to be spelled as a Save.
   */
  private adopt(tab: Tab, history: StepLedgerView | undefined): void {
    if (history === undefined) return;
    const project = this.projects.projectFor(tab.path);
    // The directory AS MAIN SPELLS IT, which is what every call back to main is
    // made with — the mirror keys on a folded copy of it and keeps this one
    // beside it. A project this window has not listed cannot be painted, and that
    // is a repaint away from fixing itself.
    if (project !== null) this.ledger.adopt(project.dir, history);
  }

  protected async save(): Promise<void> {
    const tab = this.source();
    const meta = this.record();
    if (tab === null || meta === null || !api) return;

    this.busy.set(true);
    this.problem.set(null);
    try {
      /*
       * ── THE BOOK'S SIX `dc:` FIELDS, WRITTEN INTO THE EXPORT AND INTO THE
       *    LEDGER ────────────────────────────────────────────────────────────
       *
       * This arm refused for a while, and what was missing was never the form: it
       * drew these six boxes the whole time. The EPUB write used to resolve an
       * open book's WORKING TREE by its tab's id, and the tree, the reader over it
       * and the tab kind that held it are deleted (docs/RENDERER.md §7). What is
       * on screen now when this runs is a FINISHED EXPORT — a real container in
       * `<project>/final/` — so there is a document to write into again.
       *
       * TWO THINGS HAPPEN AND THE SECOND IS THE DURABLE ONE. Main rewrites the
       * container, which is what the person sees; main also lands a metadata step,
       * which is what the NEXT cast carries. Without the step the correction would
       * live in one file and every book filed afterwards would quietly be wrong
       * again, because a bank does not know a title was fixed.
       *
       * `identifier` GOES IN THE PATCH LIKE ANY OTHER FIELD. The box is disabled
       * where the package names no unique identifier, so an unwritable one is
       * never edited and `changedField` drops it for being unchanged; the engine
       * refuses the case anyway, by name, and that sentence is better than a rule
       * repeated here.
       */
      if (meta.kind === 'epub') {
        const fields = {
          title: this.changedField(this.title(), meta.fields.title),
          creator: this.changedField(this.creator(), meta.fields.creator),
          language: this.changedField(this.language(), meta.fields.language),
          publisher: this.changedField(this.publisher(), meta.fields.publisher),
          date: this.changedField(this.date(), meta.fields.date),
          identifier: this.changedField(this.identifier(), meta.fields.identifier),
        };
        const written = await api.meta.writeEpub(tab.path, fields);
        if (!written.ok) { this.problem.set(written.reason); return; }
        /*
         * NOT `noteDocumentEdited`, WHICH THE PDF ARM CALLS AND THIS ONE MUST NOT.
         * That flag means "this document has changes the copy on disk does not
         * have", and it is what the closing question fires on. An export view has
         * no copy anywhere else: the file it is showing IS the file that was just
         * written, so raising the flag would make closing the tab ask a person to
         * save changes that are already saved.
         */
        this.adopt(tab, written.landed);
        this.ui.closeMetadata();
        return;
      }
      const patch = {
        title: this.changedField(this.title(), meta.fields.title),
        author: this.changedField(this.creator(), meta.fields.author),
        subject: this.changedField(this.subject(), meta.fields.subject),
        keywords: this.changedField(this.keywords(), meta.fields.keywords),
      };
      const outcome = await api.meta.writePdf(tab.path, patch);
      if (!outcome.ok) { this.problem.set(outcome.reason); return; }
      this.documents.noteDocumentEdited(tab.id);
      this.adopt(tab, outcome.landed);
      this.ui.closeMetadata();
    } catch (err) {
      this.problem.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }
}
