/**
 * Training tab — the three training corpora, listed from disk.
 *
 * BookForge fine-tunes three models, and each has its own corpus, its own unit
 * of work and its own store, so this tab has one sub-tab per model:
 *
 *   blocks  page layout      a BOOK of labelled blocks    training/<slug>/
 *   footnotes  footnote markers a BOOK of before/after pairs training/dagger/*.jsonl
 *   ocr  OCR correction   public corpora + scan pairs  training/galley/
 *
 * Only blocks books open in the editor: they are pages with rectangles on them,
 * which is a thing an editor can show. Footnote examples are line-level text
 * rewrites and ocr's are OCR/ground-truth string pairs, so those two tabs
 * report inventory and nothing more, and say so — a row that looks clickable
 * and is not would be worse than one that states what it is.
 *
 * The corpus master is `/Volumes/Callisto/training/rubric/`, deliberately OUTSIDE
 * the library: these are measurement material for the models, not audiobook
 * projects. So this tab talks only to the `training:*` IPC and never to
 * manifests, Studio or the queue.
 *
 * Everything shown here is read from the files each time. There is no cache to
 * go stale, which is the point — what this tab shows is what is on disk, and
 * the counts are what tells you which book to work on next.
 */

import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  ToolbarComponent,
  ToolbarItem,
  DesktopButtonComponent
} from '../../creamsicle-desktop';
import {
  ElectronService,
  PairedBook,
  PairedFile,
  TrainingBookSummary,
  TrainingCorpora
} from '../../core/services/electron.service';

/** Which corpus is on screen. One model per tab; they share nothing but a root. */
type CorpusTab = 'blocks' | 'footnotes' | 'ocr';

/** A book plus the derived bits the row needs, so the template stays flat. */
interface TrainingRow {
  book: TrainingBookSummary;
  /** 0-100. Blocks carrying a hand label, over blocks in the snapshot. */
  percent: number;
  /** What to do with this book next — the row's headline, not decoration. */
  stateLabel: string;
  /** Drives the state pill's colour class. */
  tone: 'todo' | 'partial' | 'done';
}

@Component({
  selector: 'app-training',
  standalone: true,
  imports: [CommonModule, ToolbarComponent, DesktopButtonComponent],
  template: `
    <desktop-toolbar
      [items]="toolbarItems()"
      (itemClicked)="onToolbarAction($event)"
    >
    </desktop-toolbar>

    <!-- Sits under the toolbar rather than above it because the toolbar is this
         window's chrome and does not move; what changes per tab is which of its
         buttons make sense, and that is handled in toolbarItems(). -->
    <div class="tab-strip" role="tablist" aria-label="Training corpora">
      <button
        class="tab"
        role="tab"
        [class.active]="activeTab() === 'blocks'"
        [attr.aria-selected]="activeTab() === 'blocks'"
        (click)="setTab('blocks')"
      >
        Blocks
      </button>
      <button
        class="tab"
        role="tab"
        [class.active]="activeTab() === 'footnotes'"
        [attr.aria-selected]="activeTab() === 'footnotes'"
        (click)="setTab('footnotes')"
      >
        Footnotes
      </button>
      <button
        class="tab"
        role="tab"
        [class.active]="activeTab() === 'ocr'"
        [attr.aria-selected]="activeTab() === 'ocr'"
        (click)="setTab('ocr')"
      >
        OCR
      </button>
      <span class="tab-caption">{{ tabCaption() }}</span>
    </div>

    <div class="training-container">
      @switch (activeTab()) {

        <!-- ═══ BLOCKS: page layout. The only corpus whose unit is a thing an
             editor can show, so the only one whose rows open. ═══ -->
        @case ('blocks') {
          <!-- A failed list is NOT an empty corpus, and must never be drawn as one:
               the whole value of this tab is that it reports what is actually there. -->
          @if (listError(); as err) {
            <div class="banner error" role="alert">
              <span class="banner-title">The training corpus could not be read</span>
              <span class="banner-detail">{{ err }}</span>
            </div>
          }

          <!-- Partial failure from a multi-select add: some PDFs became books, some
               didn't. The successful ones are already in the list below, so this is
               the only place the rejected ones are ever named. -->
          @if (addError(); as err) {
            <div class="banner warning" role="alert">
              <span class="banner-title">Some files were not added</span>
              <span class="banner-detail">{{ err }}</span>
            </div>
          }

          @if (openError(); as err) {
            <div class="banner error" role="alert">
              <span class="banner-title">That book did not open</span>
              <span class="banner-detail">{{ err }}</span>
            </div>
          }

          <!-- The mark is the only record that a human went through a book, so a
               write that failed has to be said out loud: the row below has been
               left showing the truth (the old mark), and silence here would read
               as the new one having stuck. -->
          @if (reviewError(); as err) {
            <div class="banner error" role="alert">
              <span class="banner-title">The review mark was not saved</span>
              <span class="banner-detail">{{ err }}</span>
            </div>
          }

          @if (loading()) {
            <div class="empty-state">
              <p>Reading {{ corpusPath }}…</p>
            </div>
          } @else {
            <!-- A book that cannot be opened is not listed as one: every row here
                 is a row you can click and get an editor from. But it is NAMED,
                 with the reason — a book whose PDF moved must not simply vanish
                 from a corpus you are counting on being complete. -->
            @if (hiddenBooks().length > 0) {
              <div class="hidden-books" role="note">
                <span class="hidden-books-head">
                  {{ hiddenBooks().length }} unopenable
                  book{{ hiddenBooks().length === 1 ? '' : 's' }} hidden:
                </span>
                @for (book of hiddenBooks(); track book.dir) {
                  <span class="hidden-book">{{ book.slug }} — {{ book.problem }}</span>
                }
              </div>
            }
          }

          @if (!loading() && rows().length > 0) {
            <div class="summary">
              <span>{{ rows().length }} book{{ rows().length === 1 ? '' : 's' }}</span>
              <span class="summary-reviewed">{{ reviewedCount() }} of {{ rows().length }} reviewed</span>
              <span class="summary-labelled">{{ totalLabelled() }} of {{ totalBlocks() }} blocks labelled</span>
            </div>

            <div class="book-list">
              @for (row of rows(); track row.book.dir) {
                <div
                  class="book"
                  [class.is-reviewed]="!!row.book.reviewedAt"
                  role="button"
                  tabindex="0"
                  (click)="openBook(row.book)"
                  (keydown.enter)="openBook(row.book)"
                  (keydown.space)="openBook(row.book)"
                >
                  <div class="book-head">
                    <span class="book-title">{{ row.book.title }}</span>
                    <span class="state-pill" [class]="'state-pill tone-' + row.tone">{{ row.stateLabel }}</span>

                    <!-- Every event this control raises is stopped here. The row is
                         a button that opens the book, so an un-stopped click would
                         both toggle the mark AND launch an editor window — and Enter
                         or Space on the focused button bubbles as a keydown the row
                         is listening for, which is the same accident by keyboard. -->
                    <button
                      type="button"
                      class="review-toggle"
                      [class.on]="!!row.book.reviewedAt"
                      [disabled]="reviewing().has(row.book.dir)"
                      [attr.aria-pressed]="!!row.book.reviewedAt"
                      [title]="reviewTooltip(row.book)"
                      (click)="toggleReviewed(row.book, $event)"
                      (keydown.enter)="$event.stopPropagation()"
                      (keydown.space)="$event.stopPropagation()"
                    >
                      <span class="review-mark">{{ row.book.reviewedAt ? '✓' : '○' }}</span>
                      <span>{{ row.book.reviewedAt ? 'Reviewed' : 'Mark reviewed' }}</span>
                    </button>
                  </div>

                  <div class="counts">
                    <span class="count"><strong>{{ row.book.pages }}</strong> pages</span>
                    <span class="count"><strong>{{ row.book.blocks }}</strong> blocks</span>
                    <span class="count">
                      <strong>{{ row.book.labelled }}</strong> of {{ row.book.blocks }} labelled
                    </span>
                    @if (row.book.reviewedAt) {
                      <span class="count reviewed-at">
                        reviewed {{ row.book.reviewedAt | date:'MMM d, y' }}
                      </span>
                    }
                    @if (row.book.savedAt) {
                      <span class="count muted">saved {{ row.book.savedAt | date:'MMM d, y, h:mm a' }}</span>
                    }
                  </div>

                  <div class="progress-track" [attr.aria-label]="row.percent + '% labelled'">
                    <div class="progress-fill" [class]="'progress-fill tone-' + row.tone" [style.width.%]="row.percent"></div>
                  </div>

                  <!-- The PDF is referenced in place, so where it lives is part of the
                       book's identity — and the first thing to check when one breaks. -->
                  <div class="book-path">{{ row.book.pdfPath ?? row.book.dir }}</div>
                </div>
              }
            </div>
          } @else if (!loading() && !listError() && hiddenBooks().length === 0) {
            <!-- Only when the corpus really is empty. A corpus whose every book is
                 unopenable has its reason printed above, and drawing "no training
                 books yet" over it would be the same silence this tab exists to
                 break. -->
            <div class="empty-state">
              <div class="empty-icon">&#128218;</div>
              <h2>No training books yet</h2>
              <p>
                Training books live in <code>{{ corpusPath }}</code>, one folder per book —
                outside the library, because they are measurement material for the page-layout
                model rather than audiobook projects.
              </p>
              <p class="hint">
                <strong>Add PDF…</strong> records a reference to a file where it already sits.
                Nothing is copied and nothing is imported, so a corpus of hundreds of scans
                costs one small JSON file each.
              </p>
              <desktop-button variant="primary" size="md" [loading]="adding()" (click)="addPdf()">
                Add PDF…
              </desktop-button>
            </div>
          }
        }

        <!-- ═══ FOOTNOTES: footnote-marker removal. Inventory only. ═══ -->
        @case ('footnotes') {
          @if (corporaError(); as err) {
            <div class="banner error" role="alert">
              <span class="banner-title">The footnotes corpus could not be read</span>
              <span class="banner-detail">{{ err }}</span>
            </div>
          } @else if (corporaLoading()) {
            <div class="empty-state">
              <p>Reading {{ corpusPath }}dagger/…</p>
            </div>
          } @else if (corpora(); as c) {
            <div class="summary">
              <span><strong>{{ c.footnotes.draft }}</strong> draft</span>
              <span><strong>{{ c.footnotes.negatives }}</strong> negatives</span>
              <span><strong>{{ c.footnotes.ambiguous }}</strong> ambiguous</span>
              <span class="summary-labelled">
                {{ c.footnotes.books.length }} book{{ c.footnotes.books.length === 1 ? '' : 's' }}
              </span>
            </div>

            <p class="tab-note">
              The footnotes model strips footnote markers from a line of body text, so its unit of work is a
              line, not a page — which is why nothing here opens in the editor.
              <strong>Draft</strong> lines carry a marker to remove and are the positive examples;
              <strong>negatives</strong> must come back byte-for-byte UNCHANGED and are the whole
              guard against a model that fires on ordinary text; <strong>ambiguous</strong> lines
              are ones the corpus builder could not decide, and are excluded from training by
              design rather than guessed at.
            </p>

            @if (c.footnotes.books.length > 0) {
              <div class="book-list">
                @for (b of c.footnotes.books; track b.book) {
                  <div class="book static">
                    <div class="book-head">
                      <span class="book-title">{{ b.book }}</span>
                      @for (v of b.versions; track v) {
                        <!-- v2 superseded v1; a book carrying both is a book whose
                             older files were never cleared out. -->
                        <span class="version-pill">{{ v }}</span>
                      }
                      <span class="state-pill">{{ b.total }} lines</span>
                    </div>
                    <div class="counts">
                      <span class="count"><strong>{{ b.draft }}</strong> draft</span>
                      <span class="count"><strong>{{ b.negatives }}</strong> negatives</span>
                      <span class="count"><strong>{{ b.ambiguous }}</strong> ambiguous</span>
                    </div>
                  </div>
                }
              </div>
            } @else {
              <div class="empty-state">
                <div class="empty-icon">&#128220;</div>
                <h2>No footnotes corpus on disk</h2>
                <p>
                  Footnote pairs are built into <code>{{ corpusPath }}dagger/</code> as
                  <code>&lt;Book&gt;.draft|negatives|ambiguous[.v2].jsonl</code> by the corpus
                  builder. Nothing in the app writes them — this tab only counts what is there.
                </p>
              </div>
            }
          }
        }

        <!-- ═══ OCR: OCR correction. Material gathered, model not built. ═══ -->
        @case ('ocr') {
          @if (corporaError(); as err) {
            <div class="banner error" role="alert">
              <span class="banner-title">The ocr corpus could not be read</span>
              <span class="banner-detail">{{ err }}</span>
            </div>
          } @else if (corporaLoading()) {
            <div class="empty-state">
              <p>Reading {{ corpusPath }}ocr/…</p>
            </div>
          } @else if (corpora(); as c) {
            <div class="banner info" role="note">
              <span class="banner-title">OCR is not built yet</span>
              <span class="banner-detail">
                There is no ocr model, no training run and no eval. What follows is the raw
                material gathered for one: public post-OCR corpora, and scans that happen to
                have a clean EPUB of the same book sitting beside them.
              </span>
            </div>

            <div class="summary">
              <span>
                {{ c.ocr.corpora.length }}
                public {{ c.ocr.corpora.length === 1 ? 'corpus' : 'corpora' }}
              </span>
              <span class="summary-labelled">
                {{ c.ocr.paired.length }} paired book{{ c.ocr.paired.length === 1 ? '' : 's' }}
              </span>
            </div>

            <h3 class="section-heading">Public post-OCR corpora</h3>
            @if (c.ocr.corpora.length > 0) {
              <div class="book-list">
                @for (g of c.ocr.corpora; track g.name) {
                  <div class="book static">
                    <div class="book-head">
                      <span class="book-title">{{ g.name }}</span>
                      <span class="state-pill">{{ formatBytes(g.bytes) }}</span>
                    </div>
                    <div class="counts">
                      <span class="count"><strong>{{ g.files }}</strong> files</span>
                    </div>
                  </div>
                }
              </div>
            } @else {
              <p class="tab-note">
                Nothing downloaded into <code>{{ corpusPath }}ocr/public-corpora/</code> yet.
              </p>
            }

            <h3 class="section-heading">Paired books</h3>
            <p class="tab-note">
              A pair is one book held BOTH as a PDF and as an EPUB: the same pages read two
              ways, which is what turns a scan into supervised OCR correction. The pairing is
              the scarce thing here, not the scan — so these are also the books worth
              hand-labelling for blocks, and each row says whether that has been done.
              Sources are the OCR lab's staged truth corpus
              (<code>{{ goldPath }}</code>, with its quality and truth tier from
              <code>manifest.json</code>) and any book placed straight into
              <code>{{ corpusPath }}</code>.
            </p>

            @if (openPairedError(); as err) {
              <div class="banner error" role="alert">
                <span class="banner-title">That book did not open for labelling</span>
                <span class="banner-detail">{{ err }}</span>
              </div>
            }

            @if (c.ocr.paired.length > 0) {
              <div class="summary">
                <span>{{ c.ocr.paired.length }} paired book{{ c.ocr.paired.length === 1 ? '' : 's' }}</span>
                <span>{{ pairedLabelled(c.ocr.paired) }} already labelled</span>
                <span class="summary-labelled">
                  {{ c.ocr.paired.length - pairedLabelled(c.ocr.paired) }} to go
                </span>
              </div>

              <div class="book-list">
                @for (p of c.ocr.paired; track p.slug) {
                  <div class="book static" [class.is-reviewed]="p.labelled">
                    <div class="book-head">
                      <span class="book-title">{{ p.title }}</span>
                      @if (p.truthTier !== null) {
                        <span
                          class="state-pill"
                          [class]="'state-pill tier-' + p.truthTier"
                          [title]="tierTooltip(p.truthTier)"
                        >tier {{ p.truthTier }}</span>
                      }
                      <span class="version-pill">{{ p.source === 'ocr-lab' ? 'ocr lab' : 'corpus root' }}</span>
                      <span
                        class="state-pill"
                        [class]="'state-pill tone-' + (p.labelled ? 'done' : 'todo')"
                        [title]="labelTooltip(p)"
                      >{{ p.labelled ? 'Labelled' : 'Not labelled' }}</span>

                      <desktop-button
                        variant="secondary"
                        size="sm"
                        [disabled]="!p.pdf?.exists"
                        [loading]="openingPaired().has(p.slug)"
                        [title]="openTooltip(p)"
                        (click)="openPaired(p)"
                      >
                        Open for labeling
                      </desktop-button>
                    </div>

                    <div class="counts">
                      <span class="count mono">{{ p.slug }}</span>
                      @if (p.labDir) {
                        <span class="count">lab run present</span>
                      } @else if (p.source === 'ocr-lab') {
                        <span class="count muted-inline">no lab run</span>
                      }
                      @if (p.labelledAt) {
                        <span class="count reviewed-at">labelled {{ p.labelledAt | date:'MMM d, y' }}</span>
                      }
                    </div>

                    @if (p.quality) {
                      <div class="quality">{{ p.quality }}</div>
                    }
                    @if (p.notes) {
                      <div class="quality notes">{{ p.notes }}</div>
                    }

                    <!-- Every file, named and checked. A file that is not there is
                         printed with its full path rather than left out: which path
                         was looked at is the first thing anyone needs to fix it. -->
                    @for (f of files(p); track f.label) {
                      <div class="file-row" [class.missing]="!f.file.exists">
                        <span class="file-label">{{ f.label }}</span>
                        <span class="book-path">{{ f.file.path }}</span>
                        <span class="file-size">
                          {{ f.file.exists ? formatBytes(f.file.bytes ?? 0) : 'MISSING' }}
                        </span>
                        <button
                          type="button"
                          class="copy-path"
                          [title]="'Copy ' + f.file.path"
                          (click)="copyPath(f.file.path)"
                        >{{ copiedPath() === f.file.path ? 'Copied' : 'Copy' }}</button>
                      </div>
                    }

                    <!-- Detect first, then correct. The model's guesses are the
                         starting point a human edits; labelling a 500-page book
                         from an empty page is the slow way and nobody does it
                         twice. Shown only where there is still labelling to do. -->
                    @if (!p.labelled) {
                      <div class="prep">
                        <span class="prep-head">Prep — run detect first, then open and correct:</span>
                        @if (detectCommand(p); as cmd) {
                          <div class="prep-cmd-row">
                            <code class="prep-cmd">{{ cmd }}</code>
                            <button
                              type="button"
                              class="copy-path"
                              [title]="'Copy ' + cmd"
                              (click)="copyPath(cmd)"
                            >{{ copiedPath() === cmd ? 'Copied' : 'Copy' }}</button>
                          </div>
                          <span class="prep-note">
                            From the repo root, with the book CLOSED. It paints the model's
                            answers into the project and never repaints a block you have
                            already labelled by hand.
                          </span>
                        } @else {
                          <span class="prep-note">
                            No library project for this book, and
                            <code>cli/blocks-detect.js</code> runs against a project's
                            <code>manifest.json</code> — so there is nothing for the headless
                            pass to write into. Open it here and use the editor's
                            <strong>Detect</strong> mode instead: that run is a preview and is
                            dropped on close, but the corrections you make are saved.
                          </span>
                        }
                      </div>
                    }

                    @if (p.problems.length > 0) {
                      <div class="problems" role="alert">
                        @for (problem of p.problems; track problem) {
                          <span class="problem">{{ problem }}</span>
                        }
                      </div>
                    }

                    @if (p.labelledIn) {
                      <div class="quality notes">
                        Labelled under a different name: {{ p.labelledIn }}
                        (matched by {{ p.matchedBy === 'recorded-pdf-path' ? 'the PDF path recorded in its book.json' : 'that PDF\\'s byte size' }}).
                      </div>
                    }
                  </div>
                }
              </div>
            } @else {
              <p class="tab-note">
                No paired books found. The OCR lab stages them in <code>{{ goldPath }}</code>,
                one folder per book holding <code>scan.pdf</code> or <code>source.pdf</code>
                beside <code>source.epub</code>; a book dropped into
                <code>{{ corpusPath }}</code> with both files counts too.
              </p>
            }
          }
        }
      }
    </div>
  `,
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      width: 100%;
    }

    .training-container {
      flex: 1;
      overflow-y: auto;
      padding: 1rem;
      background: var(--bg-base);
    }

    .tab-strip {
      flex: none;
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 0.5rem 1rem;
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border-subtle);
    }

    .tab {
      padding: 0.5rem 1rem;
      background: transparent;
      border: none;
      border-radius: 6px;
      color: var(--text-secondary);
      font-size: 0.875rem;
      font-weight: 600;
      cursor: pointer;
      transition: color 0.15s ease, background 0.15s ease;

      &:hover {
        color: var(--text-primary);
        background: var(--bg-hover);
      }

      &.active {
        color: var(--accent);
        background: var(--accent-subtle);
      }

      &:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
    }

    // Which model this corpus feeds, stated where the switch is: the three names
    // mean nothing on their own to anyone who has not read the training doc.
    .tab-caption {
      margin-left: auto;
      padding-left: 1rem;
      font-size: 0.75rem;
      color: var(--text-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .tab-note {
      margin: 0 0.25rem 0.75rem;
      max-width: 70ch;
      font-size: 0.75rem;
      line-height: 1.6;
      color: var(--text-secondary);
    }

    .tab-note code,
    .tab-note strong {
      color: var(--text-primary);
    }

    .tab-note code {
      font-family: var(--font-mono, monospace);
    }

    .section-heading {
      margin: 1.25rem 0.25rem 0.5rem;
      font-size: 0.8125rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--text-secondary);
    }

    .banner {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      padding: 0.75rem 1rem;
      margin-bottom: 1rem;
      border-radius: 8px;
      border: 1px solid var(--border-default);
      font-size: 0.8125rem;

      &.error {
        background: var(--error-bg);
        border-color: var(--error);
        color: var(--error-text);
      }

      &.warning {
        background: var(--warning-bg);
        border-color: var(--warning);
        color: var(--warning-text);
      }

      &.info {
        background: var(--info-bg);
        border-color: var(--info);
        color: var(--info-text);
      }
    }

    // Prose, not a stack trace: the "not built yet" notice is the only banner
    // here that is explaining something rather than reporting a failure.
    .banner.info .banner-detail {
      font-family: inherit;
      font-size: 0.8125rem;
      line-height: 1.5;
      white-space: normal;
    }

    .banner-title {
      font-weight: 600;
    }

    .banner-detail {
      white-space: pre-wrap;
      font-family: var(--font-mono, monospace);
      font-size: 0.75rem;
      opacity: 0.9;
    }

    .summary {
      display: flex;
      gap: 1rem;
      align-items: baseline;
      padding: 0 0.25rem 0.75rem;
      font-size: 0.75rem;
      color: var(--text-secondary);
    }

    // Muted on purpose: these are books you cannot work on, so they must be
    // findable without competing with the list of books you can.
    .hidden-books {
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
      padding: 0 0.25rem 0.75rem;
      font-size: 0.75rem;
      color: var(--text-secondary);
      opacity: 0.8;
    }

    .hidden-books-head {
      font-weight: 600;
    }

    .hidden-book {
      padding-left: 0.75rem;
    }

    .summary-reviewed {
      font-variant-numeric: tabular-nums;
    }

    .summary strong {
      color: var(--text-primary);
      font-variant-numeric: tabular-nums;
    }

    .summary-labelled {
      margin-left: auto;
      font-variant-numeric: tabular-nums;
    }

    .book-list {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .book {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      padding: 0.75rem 1rem;
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      background: var(--bg-elevated);
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s;

      &:hover {
        background: var(--bg-hover);
        border-color: var(--border-accent);
      }

      &:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }

      // Footnotes and ocr rows: inventory, with nothing behind them to open. No
      // pointer, no hover lift — the row has to look like the readout it is.
      &.static {
        cursor: default;

        &:hover {
          background: var(--bg-elevated);
          border-color: var(--border-subtle);
        }
      }

      // Done, but still findable. Recessed rather than hidden, because the mark
      // is reversible and the row is where you go to reverse it.
      &.is-reviewed {
        opacity: 0.68;

        &:hover { opacity: 1; }
      }
    }

    .book-head {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .book-title {
      flex: 1;
      min-width: 0;
      font-size: 0.9375rem;
      font-weight: 600;
      color: var(--text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .state-pill {
      flex: none;
      padding: 0.125rem 0.5rem;
      border-radius: 10px;
      font-size: 0.6875rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      background: var(--bg-sunken);
      color: var(--text-secondary);

      &.tone-todo { background: var(--info-bg); color: var(--info-text); }
      &.tone-partial { background: var(--warning-bg); color: var(--warning-text); }
      &.tone-done { background: var(--success-bg); color: var(--success-text); }

      // Truth tier, not progress: 1 is exact truth and 3 is OCR-derived, so the
      // ladder reads strongest-to-weakest rather than good-to-bad.
      &.tier-1 { background: var(--success-bg); color: var(--success-text); }
      &.tier-2 { background: var(--info-bg); color: var(--info-text); }
      &.tier-3 { background: var(--warning-bg); color: var(--warning-text); }
    }

    .version-pill {
      flex: none;
      padding: 0.125rem 0.4rem;
      border-radius: 4px;
      font-size: 0.6875rem;
      font-weight: 600;
      font-family: var(--font-mono, monospace);
      background: var(--bg-sunken);
      color: var(--text-muted);
    }

    .review-toggle {
      flex: none;
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.2rem 0.6rem;
      border-radius: 10px;
      border: 1px solid var(--border-default);
      background: var(--bg-sunken);
      color: var(--text-secondary);
      font-size: 0.6875rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s, color 0.15s;

      &:hover:not(:disabled) {
        border-color: var(--accent);
        color: var(--text-primary);
      }

      &:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }

      &:disabled {
        cursor: progress;
        opacity: 0.6;
      }

      &.on {
        background: var(--success-bg);
        border-color: var(--success);
        color: var(--success-text);
      }
    }

    .review-mark {
      font-size: 0.75rem;
      line-height: 1;
    }

    .count.reviewed-at {
      color: var(--success-text);
    }

    .counts {
      display: flex;
      flex-wrap: wrap;
      gap: 1rem;
      font-size: 0.75rem;
      color: var(--text-secondary);
      font-variant-numeric: tabular-nums;
    }

    .count strong {
      color: var(--text-primary);
      font-weight: 600;
    }

    .count.muted {
      margin-left: auto;
      color: var(--text-muted);
    }

    .progress-track {
      height: 4px;
      border-radius: 2px;
      background: var(--bg-sunken);
      overflow: hidden;
    }

    .progress-fill {
      height: 100%;
      transition: width 0.3s ease;
      background: var(--accent);

      &.tone-todo { background: var(--info); }
      &.tone-partial { background: var(--warning); }
      &.tone-done { background: var(--success); }
    }

    .book-path {
      font-size: 0.6875rem;
      color: var(--text-muted);
      font-family: var(--font-mono, monospace);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      direction: rtl;   // keep the filename visible when the path is too long
      text-align: left;
    }

    // The manifest's own words about this book's material. Prose, so it wraps.
    .quality {
      font-size: 0.75rem;
      line-height: 1.5;
      color: var(--text-secondary);
    }

    .quality.notes {
      color: var(--text-muted);
      font-style: italic;
    }

    .count.mono {
      font-family: var(--font-mono, monospace);
      color: var(--text-muted);
    }

    .count.muted-inline {
      color: var(--text-muted);
    }

    // One file of a pair. The path is the wide part and gets the space; the
    // label and the size are fixed so a column of these reads as a column.
    .file-row {
      display: flex;
      align-items: baseline;
      gap: 0.5rem;
      font-size: 0.6875rem;

      .book-path {
        flex: 1;
        min-width: 0;
      }
    }

    .file-label {
      flex: none;
      width: 4.5rem;
      font-weight: 600;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .file-size {
      flex: none;
      font-variant-numeric: tabular-nums;
      color: var(--text-muted);
    }

    // A file that is not there is the loudest thing in the row, because it is
    // the only thing in the row anybody has to act on.
    .file-row.missing {
      .file-label,
      .book-path,
      .file-size {
        color: var(--error-text);
      }

      .file-size {
        font-weight: 700;
      }
    }

    .copy-path {
      flex: none;
      padding: 0.1rem 0.45rem;
      border-radius: 4px;
      border: 1px solid var(--border-default);
      background: var(--bg-sunken);
      color: var(--text-secondary);
      font-size: 0.625rem;
      font-weight: 600;
      cursor: pointer;

      &:hover { border-color: var(--accent); color: var(--text-primary); }
      &:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    }

    // The step before the step. Recessed rather than loud: it is instruction,
    // not a fault, and it sits under every unlabelled row.
    .prep {
      display: flex;
      flex-direction: column;
      gap: 0.3rem;
      padding: 0.4rem 0.6rem;
      border-radius: 6px;
      border: 1px solid var(--border-subtle);
      background: var(--bg-sunken);
      font-size: 0.6875rem;
      line-height: 1.5;
      color: var(--text-secondary);
    }

    .prep-head {
      font-weight: 600;
      color: var(--text-primary);
    }

    .prep-cmd-row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    // The command must be copyable in one piece, so it scrolls rather than wraps
    // — a line break pasted into a shell is a different command.
    .prep-cmd {
      flex: 1;
      min-width: 0;
      overflow-x: auto;
      white-space: nowrap;
      font-family: var(--font-mono, monospace);
      color: var(--text-primary);
    }

    .prep-note code {
      font-family: var(--font-mono, monospace);
      color: var(--text-primary);
    }

    .problems {
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
      padding: 0.4rem 0.6rem;
      border-radius: 6px;
      background: var(--error-bg);
      color: var(--error-text);
      font-size: 0.6875rem;
      line-height: 1.5;
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      text-align: center;
      padding: 2rem;
      color: var(--text-secondary);
    }

    .empty-icon {
      font-size: 3rem;
      margin-bottom: 1rem;
      opacity: 0.5;
    }

    .empty-state h2 {
      margin: 0 0 0.5rem 0;
      font-size: 1.25rem;
      font-weight: 600;
      color: var(--text-primary);
    }

    .empty-state p {
      margin: 0 0 1rem 0;
      max-width: 460px;
      font-size: 0.875rem;
      line-height: 1.5;
    }

    .empty-state .hint {
      font-size: 0.8125rem;
      color: var(--text-muted);
    }

    .empty-state code {
      font-family: var(--font-mono, monospace);
      font-size: 0.8125rem;
      color: var(--text-primary);
    }
  `]
})
export default class TrainingComponent implements OnInit {
  private readonly electronService = inject(ElectronService);

  /** Named in the empty state and the loading line — the one place the corpus lives. */
  readonly corpusPath = '/Volumes/Callisto/training/rubric/';
  /** Where the OCR lab stages a book's actual PDF and EPUB. Named for the same reason. */
  readonly goldPath = '/Volumes/Callisto/training/ocr-lab/gold/';

  /** Blocks first: it is the only corpus with work to do in this app. */
  readonly activeTab = signal<CorpusTab>('blocks');

  readonly books = signal<TrainingBookSummary[]>([]);
  readonly loading = signal(true);
  readonly adding = signal(false);

  /**
   * Footnotes + ocr inventory, or null until someone asks for it.
   *
   * Deliberately NOT loaded in ngOnInit alongside the book list. Building it
   * walks `ocr/public-corpora/` file by file for a byte total (tens of
   * thousands of files) and counts newlines through every footnotes .jsonl (tens
   * of MB) — real disk work, on every visit to a tab that is opened daily to
   * pick the next blocks book to label and never scrolled past the first
   * screen. So it is paid the first time Footnotes or OCR is actually opened,
   * and after that only when Refresh is pressed on one of them.
   */
  readonly corpora = signal<TrainingCorpora | null>(null);
  readonly corporaLoading = signal(false);
  /** Why the inventory is missing. An unread corpus is never drawn as an empty one. */
  readonly corporaError = signal<string | null>(null);

  /**
   * Book dirs with a review write in flight, so a row can disable its own
   * control without a spinner signal per row and without blocking the others —
   * marking a run of books reviewed is the normal way this gets used.
   */
  readonly reviewing = signal<ReadonlySet<string>>(new Set<string>());

  /** Why the list is missing, when it is. Never collapsed into "no books". */
  readonly listError = signal<string | null>(null);
  /** Files a multi-select add rejected. Cleared at the start of the next add. */
  readonly addError = signal<string | null>(null);
  /**
   * Why the last attempt to open a book failed.
   *
   * Its own signal rather than sharing `addError`: the two are reported under
   * different headings, and a failed open shown under "Some files were not
   * added" would send someone looking for a problem with the wrong book.
   */
  readonly openError = signal<string | null>(null);
  /** Why the last review mark did not stick. Cleared when the next one is tried. */
  readonly reviewError = signal<string | null>(null);

  /** Paired books with an open in flight, by slug — the list is worked down a row at a time. */
  readonly openingPaired = signal<ReadonlySet<string>>(new Set<string>());
  /** Why the last paired book did not open. Its own heading, its own signal. */
  readonly openPairedError = signal<string | null>(null);
  /**
   * The path most recently copied, so its button can say so.
   *
   * The clipboard cannot be read back to confirm a write, and a button that
   * says nothing after a click reads as a button that did nothing.
   */
  readonly copiedPath = signal<string | null>(null);

  /**
   * Unreviewed books first, then by how much work each still needs, then title.
   *
   * The corpus is a to-do list, so the order is the order you would work it. The
   * outer split is the human pass: a book someone has declared they went through
   * completely is done with you, so every reviewed book sinks below every
   * unreviewed one no matter how well labelled the unreviewed ones are — a
   * fully-labelled book that nobody has checked still has a job left.
   *
   * Within each of those two groups the original work-remaining order stands:
   * added-but-not-OCR'd first, then OCR'd and unlabelled, then part-labelled,
   * and model-labelled-but-unchecked last. Title breaks ties so a book keeps a
   * findable position between refreshes.
   *
   * BOOKS WITH A PROBLEM ARE NOT ROWS. Clicking a row means opening a book, so
   * every row must be a book that opens: one that cannot (a moved PDF, a corrupt
   * labels.json) was a row that did nothing, which reads as the app being
   * broken. They are named above the list instead — see `hiddenBooks`.
   */
  readonly rows = computed<TrainingRow[]>(() =>
    this.books()
      .filter(book => !book.problem)
      .map(book => this.toRow(book))
      .sort((a, b) =>
        (a.book.reviewedAt ? 1 : 0) - (b.book.reviewedAt ? 1 : 0) ||
        this.rank(a) - this.rank(b) ||
        a.book.title.localeCompare(b.book.title)
      )
  );

  /**
   * The books the list is NOT showing, each with the reason it cannot open.
   *
   * Kept and printed rather than dropped: a book that quietly disappears from a
   * corpus you are counting on being complete is exactly the silent failure the
   * rest of this file refuses to produce. `listTrainingBooks` still returns them
   * — the filtering is a rendering decision, not a loss of information.
   */
  readonly hiddenBooks = computed(() =>
    this.books()
      .filter(book => !!book.problem)
      .sort((a, b) => a.slug.localeCompare(b.slug))
  );

  readonly reviewedCount = computed(() => this.rows().filter(r => !!r.book.reviewedAt).length);
  readonly totalBlocks = computed(() => this.rows().reduce((sum, r) => sum + r.book.blocks, 0));
  readonly totalLabelled = computed(() => this.rows().reduce((sum, r) => sum + r.book.labelled, 0));

  /** What the tab in front of you is for. Three model names, no shared meaning. */
  readonly tabCaption = computed(() => {
    switch (this.activeTab()) {
      case 'blocks': return 'Page layout — labelled blocks, one book per folder';
      case 'footnotes': return 'Footnote markers — before/after line pairs';
      case 'ocr': return 'OCR correction — material gathered, model not built';
    }
  });

  readonly toolbarItems = computed<ToolbarItem[]>(() => {
    const tab = this.activeTab();
    const items: ToolbarItem[] = [];

    // Add PDF… exists only on Blocks. The footnotes corpus's files are written by the corpus
    // builder and ocr's are downloaded; there is nothing on either tab that a
    // PDF could be added TO, and a button that would have to explain itself by
    // refusing is worse than a button that is not there.
    if (tab === 'blocks') {
      items.push({
        id: 'add',
        type: 'button',
        icon: '+',
        label: 'Add PDF…',
        tooltip: 'Reference a PDF where it already sits — nothing is copied or imported',
        disabled: this.adding()
      });
    }

    items.push({
      id: 'refresh',
      type: 'button',
      icon: '↻',
      label: 'Refresh',
      tooltip: tab === 'blocks'
        ? 'Re-read the training books from disk'
        : 'Re-count the corpus files on disk',
      disabled: tab === 'blocks' ? this.loading() : this.corporaLoading()
    });
    items.push({ id: 'spacer', type: 'spacer' });
    return items;
  });

  ngOnInit(): void {
    void this.refresh();
  }

  onToolbarAction(item: ToolbarItem): void {
    switch (item.id) {
      case 'add':
        void this.addPdf();
        break;
      case 'refresh':
        // Refresh means "re-read what I am looking at". The two corpora are read
        // by different IPC calls with very different costs, and refreshing the
        // one that is off screen would just be a slow no-op.
        if (this.activeTab() === 'blocks') void this.refresh();
        else void this.loadCorpora();
        break;
    }
  }

  setTab(tab: CorpusTab): void {
    this.activeTab.set(tab);
    // First open of either inventory tab pays for the disk walk; later visits
    // read the signal. Refresh is how you ask for a fresh count. A load that
    // failed leaves the signal null, so coming back to the tab retries it —
    // which is what someone who just restarted the main process would expect.
    if (tab !== 'blocks' && !this.corpora() && !this.corporaLoading()) {
      void this.loadCorpora();
    }
  }

  /**
   * Read the footnotes and ocr inventory.
   *
   * Same try/finally shape as `refresh()` and for the same reason: an
   * unregistered channel REJECTS, and without the finally the tab would sit on
   * "Reading …" forever, which reads as a slow disk rather than the plain
   * missing-handler error it is.
   */
  async loadCorpora(): Promise<void> {
    this.corporaLoading.set(true);
    let result: Awaited<ReturnType<ElectronService['trainingCorpora']>>;
    try {
      result = await this.electronService.trainingCorpora();
    } catch (err) {
      this.corporaError.set(
        `${(err as Error)?.message ?? err}\n\n` +
        'If the app was running while this feature was built, its main process ' +
        'does not have the training handlers yet — restart it.'
      );
      return;
    } finally {
      this.corporaLoading.set(false);
    }

    if (!result.success || !result.corpora) {
      // Leave `corpora` alone: whatever was last read is still the last thing
      // known to be true, and blanking it would draw a corpus that failed to
      // load as a corpus that is empty.
      this.corporaError.set(result.error ?? 'training:corpora failed without saying why.');
      return;
    }
    this.corporaError.set(null);
    this.corpora.set(result.corpora);
  }

  async refresh(): Promise<void> {
    this.loading.set(true);
    // try/finally, because `ipcRenderer.invoke` REJECTS when the channel is not
    // registered — which is exactly what a running app looks like after the main
    // process has been rebuilt but not restarted. Without this the rejection is
    // unhandled, `loading` never clears, and the tab sits on "Reading …" forever:
    // a hang that looks like slowness instead of the plain error it is.
    let result: Awaited<ReturnType<ElectronService['trainingList']>>;
    try {
      result = await this.electronService.trainingList();
    } catch (err) {
      this.listError.set(
        `${(err as Error)?.message ?? err}\n\n` +
        'If the app was running while this feature was built, its main process ' +
        'does not have the training handlers yet — restart it.'
      );
      return;
    } finally {
      this.loading.set(false);
    }

    if (!result.success) {
      // Keep whatever is already on screen: the previous list is still the last
      // thing known to be true, and blanking it would hide the books as well as
      // the error.
      this.listError.set(result.error ?? 'training:list failed without saying why.');
      return;
    }
    this.listError.set(null);
    this.books.set(result.books ?? []);
  }

  /**
   * Add PDFs to the corpus. Main owns the dialog (that is where Electron's is),
   * so this only has to interpret what comes back.
   */
  async addPdf(): Promise<void> {
    this.adding.set(true);
    this.addError.set(null);
    let result: Awaited<ReturnType<ElectronService['trainingAdd']>>;
    try {
      result = await this.electronService.trainingAdd();
    } catch (err) {
      // Same unregistered-channel case as refresh(); leaving the button spinning
      // would be the worst of both worlds.
      this.addError.set(String((err as Error)?.message ?? err));
      return;
    } finally {
      this.adding.set(false);
    }

    if (!result.success) {
      this.addError.set(result.error ?? 'training:add failed without saying why.');
      return;
    }
    // `error` alongside a successful result means a multi-select was partly
    // rejected — the books that did get made are real and are listed below.
    if (result.error) this.addError.set(result.error);
    // An empty books array with no error is a cancelled dialog: nothing to say.
    await this.refresh();
  }

  /**
   * Mark a book reviewed, or take the mark back.
   *
   * The event is killed first, unconditionally. This control lives inside a row
   * that is itself a button opening the book in an editor window, so a click
   * that reached the row would toggle the mark AND launch an editor — and the
   * editor is the slow, attention-grabbing half of that pair, so the accident
   * would not even look like an accident.
   *
   * The answer is written back into the one row rather than triggering a
   * refresh: this is used by working down a long list, and re-fetching would
   * re-sort under the cursor and throw away the scroll position each time.
   */
  async toggleReviewed(book: TrainingBookSummary, event: Event): Promise<void> {
    event.stopPropagation();
    event.preventDefault();

    if (this.reviewing().has(book.dir)) return;
    const reviewed = !book.reviewedAt;

    this.reviewError.set(null);
    this.reviewing.update(set => new Set(set).add(book.dir));

    let result: Awaited<ReturnType<ElectronService['trainingSetReviewed']>>;
    try {
      result = await this.electronService.trainingSetReviewed(book.dir, reviewed);
    } catch (err) {
      this.reviewError.set(`${book.title}: ${(err as Error)?.message ?? err}`);
      return;
    } finally {
      this.reviewing.update(set => {
        const next = new Set(set);
        next.delete(book.dir);
        return next;
      });
    }

    if (!result.success) {
      this.reviewError.set(
        `${book.title}: ${result.error ?? 'training:setReviewed failed without saying why.'}`
      );
      return;
    }

    const reviewedAt = result.reviewedAt ?? null;
    // A successful mark that came back without a timestamp would leave the row
    // showing "not reviewed" after a write that main says worked — a
    // disagreement between disk and screen that would quietly cost the user the
    // pass they just made. Say so rather than paper over it with a local clock.
    if (reviewed && !reviewedAt) {
      this.reviewError.set(
        `${book.title}: main reported the review mark as saved but returned no date, ` +
        'so what is on disk is unknown. Refresh to see the book\'s real state.'
      );
      return;
    }

    this.books.update(list =>
      list.map(b => (b.dir === book.dir ? { ...b, reviewedAt } : b))
    );
  }

  /** The date belongs on the control that sets it, where it is the only proof. */
  reviewTooltip(book: TrainingBookSummary): string {
    return book.reviewedAt
      ? `Reviewed ${new Date(book.reviewedAt).toLocaleString()} — click to take the mark back`
      : 'Mark this book as fully reviewed by a human. Reviewed books sort to the bottom.';
  }

  /** Corpora run to tens of GB; raw byte counts say nothing at that size. */
  formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
  }

  /** How many of the paired books are already in the blocks corpus. */
  pairedLabelled(paired: PairedBook[]): number {
    return paired.filter(p => p.labelled).length;
  }

  /**
   * The files of a pair, in the order they matter, each with the name it is
   * known by. Only files the book actually claims — an absent `reference` is
   * not a hole, it is a book that never had one.
   */
  files(book: PairedBook): Array<{ label: string; file: PairedFile }> {
    const rows: Array<{ label: string; file: PairedFile }> = [];
    if (book.pdf) rows.push({ label: 'PDF', file: book.pdf });
    if (book.epub) rows.push({ label: 'EPUB', file: book.epub });
    if (book.reference) rows.push({ label: 'Ref', file: book.reference });
    return rows;
  }

  /**
   * The detect-first prep command for a paired book, or null when there is
   * nothing to run it against.
   *
   * `cli/blocks-detect.js` takes `--project <dir>` and reads that project's
   * manifest — it is NOT given a PDF, so the command exists exactly when the
   * book is also a library project. The model name is left off deliberately: the
   * CLI's own default is the one answer to which checkpoint is current, and
   * pinning it here would be a second place for that to go stale.
   */
  detectCommand(book: PairedBook): string | null {
    if (!book.projectDir) return null;
    return `node --require cli/electron-stub.js cli/blocks-detect.js --project '${book.projectDir}'`;
  }

  /** What a truth tier means, where the number is shown. */
  tierTooltip(tier: number): string {
    switch (tier) {
      case 1: return 'Tier 1 — exact/definitive truth (publisher EPUB or the author\'s own book).';
      case 2: return 'Tier 2 — high-quality independent source; arbitrates, but is itself OCR-derived.';
      case 3: return 'Tier 3 — OCR-derived reference only (PDFelement). Votes, never arbitrates.';
      default: return `Truth tier ${tier}.`;
    }
  }

  /** Where the label status came from — never a bare yes/no. */
  labelTooltip(book: PairedBook): string {
    if (!book.labelled) return `No labels.json in ${book.corpusDir}`;
    switch (book.matchedBy) {
      case 'slug': return `${book.corpusDir}/labels.json`;
      case 'recorded-pdf-path':
        return `Labelled in ${book.labelledIn} — its book.json records this exact PDF.`;
      case 'recorded-pdf-size':
        return `Labelled in ${book.labelledIn} — its book.json records a PDF of the same byte size.`;
      default: return 'Labelled.';
    }
  }

  /** Why the open button will or will not do anything, on the button itself. */
  openTooltip(book: PairedBook): string {
    if (!book.pdf) return 'No PDF for this book — there are no pages to label.';
    if (!book.pdf.exists) return `Missing: ${book.pdf.path}`;
    return book.labelled
      ? `Open ${book.corpusDir} and carry on labelling`
      : `Start labelling into ${book.corpusDir}`;
  }

  /**
   * Open a paired book for labelling.
   *
   * Same two steps main does for a hand-picked PDF: mint the corpus directory if
   * this book has none, then open it in corpus mode. The list is NOT refreshed
   * afterwards — the row's label status only changes when labels are saved, and
   * re-reading the corpus would re-sort the list under the cursor mid-pass.
   */
  async openPaired(book: PairedBook): Promise<void> {
    if (!book.pdf?.exists) {
      this.openPairedError.set(
        `${book.title}: ${book.pdf ? `the PDF is not there — ${book.pdf.path}` : 'this book has no PDF.'}`
      );
      return;
    }
    if (this.openingPaired().has(book.slug)) return;

    this.openPairedError.set(null);
    this.openingPaired.update(set => new Set(set).add(book.slug));

    let result: Awaited<ReturnType<ElectronService['trainingOpenPaired']>>;
    try {
      result = await this.electronService.trainingOpenPaired({
        pdfPath: book.pdf.path,
        slug: book.slug,
        title: book.title,
      });
    } catch (err) {
      this.openPairedError.set(
        `${book.title}: ${(err as Error)?.message ?? err}\n\n` +
        'If the app was running while this feature was built, its main process ' +
        'does not have training:open-paired yet — restart it.'
      );
      return;
    } finally {
      this.openingPaired.update(set => {
        const next = new Set(set);
        next.delete(book.slug);
        return next;
      });
    }

    if (!result.success) {
      this.openPairedError.set(
        `${book.title}: ${result.error ?? 'training:open-paired failed without saying why.'}`
      );
      return;
    }
    // A directory that has just been minted is not on the Blocks tab's list yet,
    // and that list is the one that says what is in the corpus.
    if (result.created) void this.refresh();
  }

  /** Put a path on the clipboard — the EPUB has no window to open, only a path. */
  async copyPath(target: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(target);
      this.copiedPath.set(target);
    } catch (err) {
      this.openPairedError.set(`Could not copy ${target}: ${(err as Error)?.message ?? err}`);
    }
  }

  async openBook(book: TrainingBookSummary): Promise<void> {
    this.openError.set(null);
    const result = await this.electronService.trainingOpen(book.dir);
    if (!result.success) {
      this.openError.set(`${book.title} did not open: ${result.error ?? 'no reason given.'}`);
    }
  }

  /** Only ever called for a book that opens — `rows` filters the rest out. */
  private toRow(book: TrainingBookSummary): TrainingRow {
    const percent = book.blocks > 0
      ? Math.round((book.labelled / book.blocks) * 100)
      : 0;

    switch (book.state) {
      case 'added':
        // book.json only: the PDF is known, nothing has been recognized from it.
        return { book, percent, stateLabel: 'Needs OCR', tone: 'todo' };
      case 'ocr':
        return { book, percent, stateLabel: 'Needs labels', tone: 'todo' };
      case 'labelled':
        return percent >= 100
          ? { book, percent, stateLabel: 'Labelled', tone: 'done' }
          : { book, percent, stateLabel: 'In progress', tone: 'partial' };
    }
  }

  /** Work-remaining order — see `rows` for why this is the order it is. */
  private rank(row: TrainingRow): number {
    if (row.book.state === 'added') return 1;
    if (row.book.state === 'ocr') return 2;
    return row.tone === 'partial' ? 3 : 4;
  }
}
