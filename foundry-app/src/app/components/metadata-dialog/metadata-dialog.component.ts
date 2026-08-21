import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { qualify } from '@shared/documents';
import { fold } from '@shared/original';
import type { DocumentMetadata, StepLedgerView } from '@shared/types';

import { LedgerService } from '../../core/ledger.service';
import { ProjectsService } from '../../core/projects.service';
import { OpenDocumentsService, type Tab } from '../../core/documents.service';
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
 * WHAT IS EDITED IS THE WORKING COPY. For an EPUB that is the unpacked working
 * tree — the same tree every cut and every word edit writes to — so the change
 * is durable at once and Save packs it with everything else. For a PDF it is
 * the working PDF, which the engine rewrites whole; `archive/` still holds the
 * file that came in, byte for byte, which is what makes that acceptable.
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
  template: `
    <div class="scrim" (click)="ui.closeMetadata()"></div>

    <div class="card" role="dialog" aria-modal="true" aria-label="Document metadata">
      <header class="head">
        <span class="title">Metadata</span>
        <button class="x" (click)="ui.closeMetadata()" title="Close">✕</button>
      </header>

      @if (source(); as tab) {
        <div class="body">
          <!--
            THE DOCUMENT, NAMED THE WAY EVERY OTHER SURFACE NAMES IT. This box
            held the whole path, which was doubly wrong here: this dialog is
            about what a document says its title IS, and the field above the
            title box was showing a filename that the title deliberately does not
            follow (see this file's header). The path is on the tooltip.
          -->
          <label class="field">
            <span class="label">Document</span>
            <input type="text" [value]="named(tab)" readonly [title]="tab.path">
          </label>

          @if (loading()) {
            <p class="note">Reading what the document says about itself…</p>
          } @else if (record(); as meta) {
            @if (meta.kind === 'epub') {
              <label class="field">
                <span class="label">Title</span>
                <input type="text" [ngModel]="title()" (ngModelChange)="title.set($event)" name="title">
              </label>
              <label class="field">
                <span class="label">Author <em>dc:creator</em></span>
                <input
                  type="text"
                  [disabled]="doubled('creator')"
                  [ngModel]="creator()"
                  (ngModelChange)="creator.set($event)"
                  name="creator">
              </label>
              <div class="pair">
                <label class="field">
                  <span class="label">Language</span>
                  <input
                    type="text"
                    placeholder="de"
                    [ngModel]="language()"
                    (ngModelChange)="language.set($event)"
                    name="language">
                </label>
                <label class="field">
                  <span class="label">Date</span>
                  <input
                    type="text"
                    placeholder="1933"
                    [ngModel]="date()"
                    (ngModelChange)="date.set($event)"
                    name="date">
                </label>
              </div>
              <p class="note">
                The language is a tag, not a name: <code>en</code>, <code>de</code>,
                <code>pt-BR</code>. A reading system picks hyphenation and the voice it reads
                aloud in off that field, so a name there is worse than nothing.
              </p>

              <label class="field">
                <span class="label">Publisher</span>
                <input
                  type="text"
                  [disabled]="doubled('publisher')"
                  [ngModel]="publisher()"
                  (ngModelChange)="publisher.set($event)"
                  name="publisher">
              </label>

              <label class="field">
                <span class="label">Identifier <em>{{ identifierNote() }}</em></span>
                <input
                  type="text"
                  [disabled]="meta.uniqueIdentifier === null"
                  [ngModel]="identifier()"
                  (ngModelChange)="identifier.set($event)"
                  name="identifier">
              </label>

              @if (doubledFields(); as many) {
                <p class="note">
                  This package declares more than one {{ many }}. Foundry will not choose between
                  them — the wrong one corrected reads exactly like the right one — so those
                  fields are shown and not editable here.
                </p>
              }
            } @else {
              <label class="field">
                <span class="label">Title</span>
                <input type="text" [ngModel]="title()" (ngModelChange)="title.set($event)" name="title">
              </label>
              <label class="field">
                <span class="label">Author</span>
                <input type="text" [ngModel]="creator()" (ngModelChange)="creator.set($event)" name="author">
              </label>
              <label class="field">
                <span class="label">Subject</span>
                <input type="text" [ngModel]="subject()" (ngModelChange)="subject.set($event)" name="subject">
              </label>
              <label class="field">
                <span class="label">Keywords</span>
                <input
                  type="text"
                  placeholder="germany, history, 1933"
                  [ngModel]="keywords()"
                  (ngModelChange)="keywords.set($event)"
                  name="keywords">
              </label>
              <p class="note">
                {{ meta.pages }} pages. Made by
                <strong>{{ meta.producer ?? meta.creator ?? 'something that did not say' }}</strong> —
                Foundry reads that and never writes it, because rewriting it would be this app
                claiming to have produced your scan.
              </p>
              <p class="note">
                Saving re-emits the whole PDF. The file this document was imported from is kept
                untouched in the project's archive, so nothing here is irreversible.
              </p>
            }

            <!--
              Said in the dialog rather than only in a design document, because
              it is the thing somebody will otherwise expect to have happened.
            -->
            <p class="note">
              Correcting the title does not rename any file. The document keeps the name it has,
              because that name is in your recents and in whatever else points at it.
            </p>
          }

          @if (problem(); as reason) {
            <p class="problem">{{ reason }}</p>
          }
        </div>

        <footer class="foot">
          <button class="ghost" (click)="ui.closeMetadata()">Cancel</button>
          <button class="primary" [disabled]="busy() || loading() || record() === null" (click)="save()">
            {{ busy() ? 'Saving…' : 'Save' }}
          </button>
        </footer>
      } @else {
        <div class="body empty">
          <p>
            Open a book or a scan first — metadata is a thing a document has, and there is no
            document in front of you.
          </p>
        </div>
        <footer class="foot">
          <button class="ghost" (click)="ui.closeMetadata()">Close</button>
          <button class="primary" (click)="openDocument()">Open document…</button>
        </footer>
      }
    </div>
  `,
  styles: [`
    :host { position: fixed; inset: 0; z-index: 1200; display: block; }

    .scrim {
      position: absolute; inset: 0;
      background: rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(4px);
      animation: fade 120ms cubic-bezier(0, 0, 0.2, 1);
    }

    .card {
      position: relative;
      margin: 8vh auto 0;
      width: 460px;
      max-width: calc(100vw - 32px);
      max-height: 82vh;
      display: flex;
      flex-direction: column;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-lg);
      box-shadow:
        0 10px 15px -3px rgba(0, 0, 0, 0.2),
        0 20px 40px -10px rgba(0, 0, 0, 0.35);
      overflow: hidden;
      animation: rise 140ms cubic-bezier(0.34, 1.56, 0.64, 1);
    }

    @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
    @keyframes rise {
      from { opacity: 0; transform: scale(0.94); }
      to { opacity: 1; transform: scale(1); }
    }

    .head {
      display: flex; align-items: center; gap: 8px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .title { flex: 1; font-family: var(--font-display); font-weight: 600; font-size: 16px; }
    .x {
      background: transparent; border: none; cursor: pointer;
      color: var(--text-tertiary); font-size: 13px;
      padding: 3px 5px; border-radius: var(--radius-sm);
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .x:hover { background: var(--bg-hover); color: var(--text-primary); }

    .body { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 14px; }
    .body.empty { color: var(--text-secondary); font-size: 13px; line-height: 1.5; }
    .body.empty p { margin: 0; }

    .field { display: flex; flex-direction: column; gap: 6px; }
    /* Two short answers on one row: a language tag and a year each need four
       characters, and giving them a line apiece makes the card scroll. */
    .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .label {
      font-size: 10px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.08em; color: var(--text-tertiary);
    }
    .label em { text-transform: none; letter-spacing: 0; font-style: normal; font-weight: 400; opacity: 0.75; }

    .note { margin: 0; font-size: 11px; color: var(--text-tertiary); line-height: 1.5; }
    .note code { font-family: var(--font-mono); font-size: 10px; color: var(--text-secondary); }
    .note strong { color: var(--text-secondary); font-weight: 600; }
    .problem { margin: 0; font-size: 12px; color: var(--warn); }

    .foot {
      display: flex; justify-content: flex-end; gap: 8px;
      padding: 12px 16px 16px;
      border-top: 1px solid var(--border-subtle);
    }
    .primary, .ghost {
      display: inline-flex; align-items: center; justify-content: center;
      height: 32px; padding: 0 16px;
      border-radius: var(--radius-md);
      font-size: 13px; font-weight: 500; line-height: 1;
      cursor: pointer;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  border-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  transform 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .primary {
      border: none;
      background: var(--accent); color: var(--text-inverse);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.1);
    }
    .primary:hover:not(:disabled) { background: var(--accent-hover); }
    .primary:active:not(:disabled) { background: var(--accent-active); transform: scale(0.98); }
    .primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .ghost {
      background: var(--bg-input);
      border: 1px solid var(--border-default);
      color: var(--text-primary);
    }
    .ghost:hover { background: var(--bg-hover); border-color: var(--border-strong); }
    .ghost:active { background: var(--bg-active); transform: scale(0.98); }
  `],
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
   */
  protected readonly source = computed(() => {
    const tab = this.stage.activeDocument();
    if (tab === null) return null;
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
   */
  protected named(tab: Tab): string {
    return qualify(tab.title, 'pdf', '');
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
      const outcome = await api.meta.readPdf(tab.path);
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
       * ONE FORMAT REACHES THE WRITE NOW. The EPUB arm resolved an open book's
       * WORKING TREE by its tab's book id, and the tree, the reader over it and
       * the tab kind that held it are deleted (docs/RENDERER.md §7). The FORM
       * still knows both shapes — `meta.kind === 'epub'` draws six `dc:` fields
       * against a record read from a document — because a record read from an
       * imported EPUB is still a record; what has no door any more is writing one
       * back through a book this app no longer opens as a file.
       */
      if (meta.kind === 'epub') {
        this.problem.set(
          'Foundry edits a book through its own steps now, not by writing into the container it '
          + 'was imported from. This document’s details are read-only here.',
        );
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
