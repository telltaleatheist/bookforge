import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';

import {
  asciiFilename, contributorsFromString, generatedFilename, MINT_LANGUAGES,
} from '@shared/mint-meta';
import type { MintContributor, MintMeta } from '@shared/mint-meta';
import type { JobRequest, WorkspacePlan } from '@shared/types';

import { NoticeService } from '../../core/notice.service';
import { OpenDocumentsService } from '../../core/documents.service';
import { QueueService } from '../../core/queue.service';
import { UiService } from '../../core/ui.service';
import { api } from '../../core/foundry';

/**
 * THE MINT METADATA DIALOG — who this book says it is, confirmed at the mint.
 *
 * ── The ruling ──────────────────────────────────────────────────────────────
 *
 * Owen, 2026-08-24: *"go ahead and build the metadata modal with the fields
 * outlined by bookforge. it should work when the user mints a new epub OR when
 * theyre hovering on an epub and click the metadata tile. when they save, it
 * should write the metadata to the epub."* The fields and the filename
 * convention are BookForge's metadata editor, mirrored field for field
 * (shared/mint-meta.ts carries the convention and the argument); the write is
 * the engine's `epub-meta` splice — a side file and one rename, near instant —
 * which is the same machinery the metadata steps have always stamped with.
 *
 * ── TWO MODES, ONE FORM ─────────────────────────────────────────────────────
 *
 * MINT: opened by the Export dialog's EPUB press, BEFORE anything runs.
 * Filling it is how the person knows what they are exporting and as what: the
 * fields pre-fill from the project's stored block (or a seed composed from
 * the scan's own Info dictionary on first use), the filename generates live
 * in BookForge's convention, and Export runs the whole mint from here — the
 * queue request, the landing, the metadata stamped into the finished file by
 * main at the settle (`JobRequest.mintMeta`).
 *
 * EDIT: opened by the dock's Metadata tile over a finished EPUB export. Same
 * form, no filename row (the file keeps its name — renaming a filed export
 * would orphan every host record that names it), and Save writes the block to
 * the project AND stamps the open file in place.
 *
 * ── WHAT LANGUAGE PRE-FILLS, AND WHAT LANGUAGE STAMPS ───────────────────────
 *
 * The select PRE-FILLS from the position — the plan's language for a
 * translated position, the project's stored preference otherwise — because
 * the field exists so a person CONFIRMS it. But the stamp at the settle takes
 * the chain's own language over the form's whenever the chain declares one:
 * an export of a German step must say de whatever the form remembered. The
 * form's language matters most exactly where the chain is silent.
 */
@Component({
  selector: 'app-mint-meta-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    @if (ui.mintMetaOpen(); as ask) {
      <div class="scrim" (click)="ui.closeMintMeta()"></div>

      <div class="card" role="dialog" aria-modal="true" aria-label="Book metadata">
        <header class="head">
          <span class="title">{{ ask.mode === 'mint' ? 'Export EPUB' : 'Metadata' }}</span>
          <button class="x" (click)="ui.closeMintMeta()" title="Close">✕</button>
        </header>

        <div class="body">
          @if (ask.mode === 'edit') {
            <label class="field">
              <span class="label">Document</span>
              <input type="text" [value]="ask.file" readonly [title]="ask.path">
            </label>
          }

          <label class="field">
            <span class="label">Title</span>
            <input type="text" [ngModel]="title()" (ngModelChange)="edit(title, $event)" name="title">
          </label>
          <label class="field">
            <span class="label">Subtitle</span>
            <input type="text" [ngModel]="subtitle()" (ngModelChange)="edit(subtitle, $event)" name="subtitle">
          </label>

          <!--
            AUTHORS AS A LIST, BookForge's own shape: {first, last} rows with
            add/remove, the first row the primary. The filename reads them
            through the 1 / 2 / "et al." convention, and the display string is
            "First Last, First Last" wherever one line is wanted.
          -->
          <div class="field">
            <span class="label">Authors</span>
            @for (author of authors(); track $index) {
              <div class="author">
                <input
                  type="text"
                  placeholder="First"
                  [ngModel]="author.first"
                  (ngModelChange)="editAuthor($index, 'first', $event)"
                  [name]="'author-first-' + $index">
                <input
                  type="text"
                  placeholder="Last"
                  [ngModel]="author.last"
                  (ngModelChange)="editAuthor($index, 'last', $event)"
                  [name]="'author-last-' + $index">
                <button
                  type="button"
                  class="x"
                  title="Remove this author"
                  [disabled]="authors().length === 1"
                  (click)="removeAuthor($index)"
                >✕</button>
              </div>
            }
            <button type="button" class="add" (click)="addAuthor()">+ Add author</button>
          </div>

          <div class="pair">
            <label class="field">
              <span class="label">Year</span>
              <input type="text" placeholder="1934" [ngModel]="year()" (ngModelChange)="edit(year, $event)" name="year">
            </label>
            <label class="field">
              <span class="label">Language</span>
              <select [ngModel]="language()" (ngModelChange)="edit(language, $event)" name="language">
                @for (option of languages(); track option.value) {
                  <option [value]="option.value">{{ option.label }}</option>
                }
              </select>
            </label>
          </div>

          @if (ask.mode === 'mint') {
            <!--
              THE FILENAME, LIVE — BookForge's convention exactly, and their
              override semantics exactly: it regenerates from the fields until
              the person types in it, and from then on their spelling stands.
              Focusing the empty field seeds it with the generated name so
              there is something to edit rather than a blank to compose into.
            -->
            <label class="field">
              <span class="label">Filename</span>
              <input
                type="text"
                [ngModel]="filenameShown()"
                (ngModelChange)="overrideFilename($event)"
                (focus)="seedFilename()"
                name="filename">
            </label>
            <p class="note">
              On disk the name is simplified to ASCII — the book’s own metadata keeps the real
              characters.
            </p>
          } @else {
            <p class="note">
              Saving stamps this file where it is filed — a side file and one rename, near
              instant — and remembers the answers for the next book minted from this project.
              The file keeps its name.
            </p>
          }

          @if (problem(); as said) {
            <p class="problem">{{ said }}</p>
          }
        </div>

        <footer class="foot">
          <button class="ghost" (click)="ui.closeMintMeta()">Cancel</button>
          <button class="primary" [disabled]="busy()" (click)="confirm()">
            {{ busy() ? 'Working…' : ask.mode === 'mint' ? 'Export' : 'Save' }}
          </button>
        </footer>
      </div>
    }
  `,
  styles: [`
    :host { position: fixed; inset: 0; z-index: 1200; display: block; pointer-events: none; }

    .scrim {
      pointer-events: auto;
      position: absolute; inset: 0;
      background: rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(4px);
      animation: fade 120ms cubic-bezier(0, 0, 0.2, 1);
    }

    .card {
      pointer-events: auto;
      position: relative;
      margin: 8vh auto 0;
      width: 480px;
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
    .x:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
    .x:disabled { opacity: 0.35; cursor: default; }

    .body { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 14px; }

    .field { display: flex; flex-direction: column; gap: 6px; }
    .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .label {
      font-size: 10px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.08em; color: var(--text-tertiary);
    }

    /* One author to a row: first, last, and the ✕ that takes the row away. */
    .author { display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; align-items: center; }
    .add {
      align-self: flex-start;
      background: transparent; border: none; cursor: pointer;
      color: var(--text-secondary); font-size: 12px;
      padding: 2px 0;
    }
    .add:hover { color: var(--text-primary); }

    .note { margin: 0; font-size: 11px; color: var(--text-tertiary); line-height: 1.5; }
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

    input, select {
      height: 30px;
      padding: 0 10px;
      border-radius: var(--radius-md);
      border: 1px solid var(--border-default);
      background: var(--bg-input);
      color: var(--text-primary);
      font-size: 13px;
      font-family: inherit;
    }
    input:focus, select:focus { outline: none; border-color: var(--accent); }
    input[readonly] { color: var(--text-secondary); }
  `],
})
export class MintMetaDialogComponent {
  protected readonly ui = inject(UiService);
  private readonly documents = inject(OpenDocumentsService);
  private readonly queue = inject(QueueService);
  private readonly notices = inject(NoticeService);

  protected readonly title = signal('');
  protected readonly subtitle = signal('');
  protected readonly authors = signal<MintContributor[]>([{ first: '', last: '' }]);
  protected readonly year = signal('');
  protected readonly language = signal('en');
  protected readonly busy = signal(false);
  protected readonly problem = signal<string | null>(null);

  /**
   * The manual filename, or null while it tracks the fields — BookForge's
   * `filenameManuallyEdited`, spelled as the override's own presence so there
   * is one fact rather than a string and a flag to keep agreeing.
   */
  private readonly filenameOverride = signal<string | null>(null);

  /** The export plan, held from open to run so both halves read one answer. */
  private plan: WorkspacePlan | null = null;

  /**
   * The select's menu: BookForge's eight, plus the pre-filled language when it
   * is not one of them — a book detected as Hungarian must not have its truth
   * silently swapped for the nearest thing a menu happened to hold.
   */
  protected readonly languages = computed(() => {
    const chosen = this.language();
    if (MINT_LANGUAGES.some((one) => one.value === chosen)) return MINT_LANGUAGES;
    return [{ value: chosen, label: chosen }, ...MINT_LANGUAGES];
  });

  protected readonly filenameShown = computed(() =>
    this.filenameOverride() ?? generatedFilename(this.formMeta(), 'epub'));

  constructor() {
    /*
     * LOADED AT OPEN, RESET AT CLOSE. The one effect reads the ask and nothing
     * else, so typing in the form never re-runs the load — the same shape
     * every dialog here keeps.
     */
    effect(() => {
      const ask = this.ui.mintMetaOpen();
      untracked(() => {
        if (ask === null) return;
        this.problem.set(null);
        this.busy.set(false);
        this.filenameOverride.set(null);
        this.plan = null;
        void this.load(ask);
      });
    });
  }

  /** The form, as a MintMeta — what saves, what names the file. */
  private formMeta(): MintMeta {
    const named = this.authors().filter((one) => one.first || one.last);
    return {
      title: this.title().trim(),
      contributors: named,
      ...(this.subtitle().trim() ? { subtitle: this.subtitle().trim() } : {}),
      ...(this.year().trim() ? { year: this.year().trim() } : {}),
      ...(this.language() ? { language: this.language() } : {}),
    };
  }

  /** One field edited: set it, and let the filename go back to tracking. */
  protected edit(field: { set(value: string): void }, value: string): void {
    field.set(value);
  }

  protected editAuthor(index: number, half: 'first' | 'last', value: string): void {
    this.authors.update((held) =>
      held.map((one, at) => (at === index ? { ...one, [half]: value } : one)));
  }

  protected addAuthor(): void {
    this.authors.update((held) => [...held, { first: '', last: '' }]);
  }

  protected removeAuthor(index: number): void {
    this.authors.update((held) => held.filter((_, at) => at !== index));
  }

  /** A typed filename stands; BookForge's manual-edit rule. */
  protected overrideFilename(value: string): void {
    this.filenameOverride.set(value);
  }

  /** Focusing the empty field seeds it with the generated name, editable. */
  protected seedFilename(): void {
    if (this.filenameOverride() === null) {
      this.filenameOverride.set(generatedFilename(this.formMeta(), 'epub'));
    }
  }

  /**
   * Pre-fill: the stored block when the project has one; otherwise a seed —
   * the scan's own Info dictionary read through the comma rule, under the
   * project's display title. The plan is fetched here for the MINT mode so
   * the language can pre-fill from the position (a translated position's
   * plan carries its language) and the run later writes into the folder the
   * plan named.
   */
  private async load(ask: NonNullable<ReturnType<UiService['mintMetaOpen']>>): Promise<void> {
    if (!api) return;
    try {
      const stored = await api.meta.readMint(ask.projectDir);
      let planLanguage: string | undefined;
      if (ask.mode === 'mint') {
        this.plan = await api.workspace.planExport(ask.inputPath, 'epub');
        planLanguage = this.plan.language ?? undefined;
      }
      if (stored !== null) {
        this.title.set(stored.title);
        this.subtitle.set(stored.subtitle ?? '');
        this.authors.set(stored.contributors.length > 0
          ? stored.contributors.map((one) => ({ ...one }))
          : [{ first: '', last: '' }]);
        this.year.set(stored.year ?? '');
        this.language.set(planLanguage ?? stored.language ?? 'en');
        return;
      }
      /*
       * THE SEED. In edit mode the file itself is the best witness — its OPF
       * already says a title and a creator; in mint mode the scan's Info
       * dictionary is (read leniently — a scan with no Info is ordinary). A
       * failure to read either is a blank form, not a refusal: the person is
       * about to type over it anyway.
       */
      if (ask.mode === 'edit') {
        const read = await api.meta.readEpub(ask.path).catch(() => null);
        if (read?.ok && read.metadata.kind === 'epub') {
          const fields = read.metadata.fields;
          this.title.set(fields.title ?? '');
          const creator = fields.creator ?? '';
          this.authors.set(creator
            ? contributorsFromString(creator)
            : [{ first: '', last: '' }]);
          this.year.set(fields.date ?? '');
          this.language.set(fields.language ?? 'en');
          return;
        }
      } else {
        const read = await api.meta.readPdf(ask.inputPath).catch(() => null);
        if (read?.ok && read.metadata.kind === 'pdf') {
          const fields = read.metadata.fields;
          this.title.set(fields.title ?? '');
          const author = fields.author ?? '';
          this.authors.set(author
            ? contributorsFromString(author)
            : [{ first: '', last: '' }]);
          this.language.set(planLanguage ?? 'en');
          return;
        }
      }
      this.title.set('');
      this.authors.set([{ first: '', last: '' }]);
      this.language.set(planLanguage ?? 'en');
    } catch (err) {
      this.problem.set(err instanceof Error ? err.message : String(err));
    }
  }

  protected async confirm(): Promise<void> {
    const ask = this.ui.mintMetaOpen();
    if (ask === null || !api) return;
    this.busy.set(true);
    this.problem.set(null);
    try {
      const meta = this.formMeta();
      // THE INHERITANCE: what was confirmed is what the next mint pre-fills.
      await api.meta.writeMint(ask.projectDir, meta);

      if (ask.mode === 'edit') {
        await api.meta.stampMint(ask.path, meta);
        this.notices.notice.set(`Stamped ${ask.file} — and every book minted from here inherits it.`);
        this.ui.closeMintMeta();
        return;
      }

      const plan = this.plan ?? await api.workspace.planExport(ask.inputPath, 'epub');
      /*
       * THE NAME THE PERSON CONFIRMED, in the folder the plan named — the
       * override or the generated one, ASCII-folded for the disk. The plan's
       * own output name is the stem convention; this dialog's whole point is
       * that the person names the file.
       */
      const parts = plan.outputPath.split(/[\\/]/);
      parts.pop();
      const filed = asciiFilename(this.filenameShown()).replace(/\.epub$/i, '') + '.epub';
      const outputPath = [...parts, filed].join('\\');
      const request: JobRequest = {
        kind: 'epub',
        inputPath: plan.sourcePath,
        outputPath,
        readingsPath: plan.readingsPath,
        export: true,
        mintMeta: meta,
        ...(plan.records !== undefined ? { records: plan.records } : {}),
        ...(plan.language !== undefined ? { language: plan.language } : {}),
        ...(plan.bookPath !== undefined ? { bookPath: plan.bookPath } : {}),
      };
      const job = await this.queue.run(request);
      if (job === null) return;
      if (job.state === 'held' || job.state === 'queued' || job.state === 'running') {
        this.problem.set(`${filed} is already being made.`);
        return;
      }
      if (job.state === 'failed') {
        this.problem.set(job.error ?? 'The EPUB could not be made.');
        return;
      }
      if (job.state === 'cancelled') {
        this.problem.set('The export was stopped before it finished. Nothing was filed.');
        return;
      }
      this.documents.openExportView(job.outputPath, filed);
      this.notices.notice.set(`Wrote ${filed} — filed under this project.`);
      this.ui.closeMintMeta();
    } catch (err) {
      this.problem.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }
}
