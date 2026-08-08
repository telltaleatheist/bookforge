/**
 * book-conversion — who owns a Convert to EPUB while it is happening.
 *
 * `foundry vlm-convert` is ninety minutes for a 300-page book, and Owen's design
 * (2026-08-07) puts the button on Studio's Versions page and lets the user walk
 * away from the modal. Those two facts together are the whole reason this is a
 * service and not state inside the modal component: a run that a component owns
 * dies with the component, and "Run in background" would either be a lie or
 * would have to keep a destroyed component alive to hear the end of its own job.
 *
 * So the RUN lives here, at the application's root, and the modal and the
 * versions row are two views of it. Closing the modal is closing a window onto
 * something that is still happening; re-opening it re-attaches to the same run.
 *
 * ── It is not the queue, and that is deliberate ─────────────────────────────
 *
 * The obvious home for "a long job you can watch" is the Queue tab. But the
 * queue OWNS execution: it holds pending rows, picks them up, and drives them
 * through `runJob`. A conversion is already running in MAIN before the renderer
 * could enqueue anything — `withProjectStage` claimed the project, foundry is
 * spawned, and an ng-serve reload does not touch it. Representing that as a
 * queue row means a row the queue must never start, never retry, never resume
 * and never persist, which is a second execution model wearing the first one's
 * clothes. The progress is shown where the button was pressed instead.
 *
 * ── Nothing here decides anything main also decides ─────────────────────────
 *
 * The endpoint config is read from settings and handed over per run, exactly as
 * `ollamaBaseUrl` travels on a job config; main resolves it again and refuses the
 * same things. `resolveVlmRoute` is called here only to say WHICH GPU is about to
 * be busy before the first page lands, and it is given the same facts main gives
 * it — including `vlm:reader-status`, which only main can answer. A card that
 * promised a route the run then denied would be worse than no card.
 */
import { Injectable, computed, inject, signal } from '@angular/core';

import { ElectronService } from '../../../core/services/electron.service';
import { SettingsService } from '../../../core/services/settings.service';
import { DialogService } from '../../../creamsicle-desktop';
import {
  VLM_CONVERT_STAGE,
  resolveVlmEndpoint,
  resolveVlmRoute,
  vlmRouteLabel,
  type VlmConvertResult,
  type VlmEndpointConfig,
} from '@shared/vlm/conversion';
import { samePath } from '@shared/document/same-path';

/** Which document the user pressed the button on. It is the whole difference. */
export type ConversionSource = 'archive' | 'working';

/** A conversion that is happening right now, as the two views of it need it. */
export interface ConversionRun {
  /** Absolute project directory — the identity of the run, as it is in main. */
  projectDir: string;
  from: ConversionSource;
  /** The row's own label, so every sentence names the file the user pressed. */
  sourceLabel: string;
  /** Which GPU is reading the pages, in words. Known before the first page. */
  route: string;
  /** foundry's own line, verbatim. */
  message: string;
  done: number;
  total: number;
  /** A stop has been asked for and foundry has not exited yet. */
  stopping: boolean;
}

/** What starting one needs. Everything else is read from settings or measured. */
export interface ConversionRequest {
  projectDir: string;
  from: ConversionSource;
  sourceLabel: string;
  /** The PDF variant, when the row carries one — the archive row does. */
  variantId?: string;
  /**
   * The archive PDF itself, for a row that names a file rather than a variant.
   *
   * The working-copy row is that row: it is a sidecar, not a version of the
   * book, so it has no variant id — only the original it was copied from. With
   * neither, `resolveDocumentProject` falls back to "the project's single PDF"
   * and REFUSES a project holding two, which would turn Create EPUB into a
   * question for exactly the users who curated one of two editions.
   */
  sourcePath?: string;
}

@Injectable({ providedIn: 'root' })
export class BookConversionService {
  private readonly electron = inject(ElectronService);
  private readonly settings = inject(SettingsService);
  private readonly dialog = inject(DialogService);

  /**
   * The live runs, keyed by project directory.
   *
   * A map rather than a single run because the identity of a conversion is the
   * project — main's stage registry allows one per project and refuses a second
   * by name — and two projects converting at once is a legal state this must not
   * quietly collapse into one bar.
   */
  private readonly _runs = signal<ReadonlyMap<string, ConversionRun>>(new Map());

  /** Anything converting anywhere. Cheap enough for a template to read. */
  readonly anyRunning = computed(() => this._runs().size > 0);

  /** The conversion running for this project, or null. Reactive. */
  runFor(projectDir: string): ConversionRun | null {
    if (!projectDir) return null;
    for (const run of this._runs().values()) {
      if (samePath(run.projectDir, projectDir)) return run;
    }
    return null;
  }

  /**
   * Why the pages cannot be read on any machine this app can reach, or null.
   *
   * Asked BEFORE the modal opens, so a refusal is a sentence about a setting
   * rather than a progress bar that fails four seconds later. It is the same
   * `resolveVlmRoute` the run itself calls, given the same facts, which is what
   * stops the two disagreeing.
   */
  async refusal(): Promise<string | null> {
    let endpoint: VlmEndpointConfig | null;
    try {
      endpoint = resolveVlmEndpoint(this.settings.getVlmEndpointConfig());
    } catch (err) {
      return (err as Error).message;
    }
    // Asked of main every time rather than cached: the WSL toggle and env name
    // live in Settings, and a user who has just filled them in must not have to
    // restart the window before Convert believes them.
    const status = await this.electron.vlmReaderStatus();
    if (!status.success) {
      return `BookForge could not check the WSL page reader: ${status.error}`;
    }
    const route = resolveVlmRoute({
      platform: this.electron.platform,
      arch: this.electron.arch,
      endpoint,
      wslReaderRefusal: status.wslRefusal ?? null,
    });
    return route.kind === 'refused' ? route.reason : null;
  }

  /**
   * Run the conversion, and resolve when it is over either way.
   *
   * The caller may stop awaiting this at any time — that is exactly what "Run in
   * background" does — so everything the user needs to be told is told from
   * HERE: the completion names the book, the failure names its own reason, and
   * neither depends on anybody still being on the other end of the promise.
   *
   * A second conversion of the same project is refused by main's stage registry
   * by name. It is refused here too, first, because the honest answer is already
   * in hand and there is no reason to make a round trip to be told it.
   */
  async start(request: ConversionRequest): Promise<void> {
    const existing = this.runFor(request.projectDir);
    if (existing) {
      await this.dialog.alert({
        title: 'Already converting',
        message: `${existing.sourceLabel} is being converted right now.`,
        detail: 'A project converts one document at a time — two conversions would be two writers '
          + 'on one book. Wait for this one to finish, or stop it first.',
        type: 'warning',
      });
      return;
    }

    let endpoint: VlmEndpointConfig | null;
    try {
      endpoint = resolveVlmEndpoint(this.settings.getVlmEndpointConfig());
    } catch (err) {
      await this.failed(request.sourceLabel, (err as Error).message);
      return;
    }

    this.put({
      projectDir: request.projectDir,
      from: request.from,
      sourceLabel: request.sourceLabel,
      // Said before anything spawns, and replaced by main's own first progress
      // line the moment it arrives — which is the one that knows whether the WSL
      // reader was started. Until then this is the honest half of the answer.
      route: vlmRouteLabel(endpoint),
      message: 'Starting…',
      done: 0,
      total: 0,
      stopping: false,
    });

    // Filtered on the PROJECT and nothing else. `document:stage-progress` carries
    // the pipeline stage id while `-started` and `-finished` carry the
    // user-facing label, so a filter matching the wrong one of those would drop
    // every line in silence. A project holds one stage at a time — main refuses
    // a second by name — so the project IS the whole filter.
    const unwatch = this.electron.onDocumentStageProgress((event) => {
      if (!samePath(event.projectDir, request.projectDir)) return;
      this.patch(request.projectDir, {
        message: event.message,
        done: event.done,
        total: event.total,
      });
    });

    try {
      const answer = await this.electron.convertPdfToEpub({
        projectDir: request.projectDir,
        ...(request.variantId ? { variantId: request.variantId } : {}),
        ...(request.sourcePath ? { sourcePath: request.sourcePath } : {}),
        ...(endpoint !== null ? { endpoint } : {}),
        // The whole difference between the two buttons. Main reads WHICH pages
        // that is off the working document itself.
        ...(request.from === 'working' ? { skipDeletedPages: true } : {}),
      });
      if (!answer.success || !answer.result) {
        throw new Error(answer.error || 'The conversion failed and said nothing about why.');
      }
      await this.finished(answer.result);
    } catch (err) {
      await this.failed(request.sourceLabel, (err as Error).message);
    } finally {
      unwatch();
      this.drop(request.projectDir);
    }
  }

  /**
   * Stop a conversion, keeping every page already read.
   *
   * Safe by construction rather than by promise: foundry banks each page's answer
   * into the readings file as it lands, keyed by the PDF's sha256, and a later
   * run reads only what is missing. So this costs the page in flight and nothing
   * else, which is why it is offered without a confirmation.
   */
  async stop(projectDir: string): Promise<void> {
    const run = this.runFor(projectDir);
    if (!run || run.stopping) return;
    this.patch(projectDir, { stopping: true, message: 'Stopping…' });
    // The stage is main's, so main is what stops it. The `start` promise then
    // rejects with foundry's own exit and lands in `failed` like any other
    // ending — there is no separate "cancelled" bookkeeping to drift.
    await this.electron.documentCancelStage(projectDir);
  }

  /**
   * The book is built, and the alert names it.
   *
   * The versions page re-measures on its own: main broadcasts
   * `document:stage-finished` from a `finally` and `project:files-changed` after
   * the record is written, and the page listens to both. Nothing is announced to
   * it from here, so a conversion the user backgrounded lands the same way as one
   * they watched.
   */
  private async finished(result: VlmConvertResult): Promise<void> {
    const where = result.endpoint === null ? 'this machine' : result.endpoint;
    const notes: string[] = [];
    if (result.skippedPages.length > 0) {
      notes.push(
        `${result.skippedPages.length} page(s) you deleted in the working copy were left out: `
        + `${result.skippedPages.join(', ')}.`
      );
    }
    if (result.unreadable.length > 0) {
      // Said here and not only in the log: a page the model could not read is a
      // page of the user's book that is not in it.
      notes.push(
        `${result.unreadable.length} page(s) could NOT be read and are missing: `
        + `${result.unreadable.map((p) => p.page).join(', ')}. The first reason given was `
        + `"${result.unreadable[0].reason}". Converting again re-reads only those pages.`
      );
    }
    await this.dialog.alert({
      title: 'The book is built',
      message: `${result.relPath} — ${result.totalPages} page(s) read by ${where}.`,
      detail: [
        ...notes,
        'Open it at the EPUB station to strike out anything you do not want narrated.',
      ].join('\n\n'),
      type: result.unreadable.length > 0 ? 'warning' : 'info',
    });
  }

  private async failed(sourceLabel: string, message: string): Promise<void> {
    await this.dialog.alert({
      title: `${sourceLabel} was not converted`,
      message,
      detail: 'Every page already read is kept. Converting again resumes from where this stopped.',
      type: 'error',
    });
  }

  // ── The map ────────────────────────────────────────────────────────────────

  private put(run: ConversionRun): void {
    this._runs.update((runs) => new Map(runs).set(run.projectDir, run));
  }

  private patch(projectDir: string, fields: Partial<ConversionRun>): void {
    this._runs.update((runs) => {
      const current = runs.get(projectDir);
      if (!current) return runs;
      return new Map(runs).set(projectDir, { ...current, ...fields });
    });
  }

  private drop(projectDir: string): void {
    this._runs.update((runs) => {
      if (!runs.has(projectDir)) return runs;
      const next = new Map(runs);
      next.delete(projectDir);
      return next;
    });
  }
}

/** The stage's name, re-exported so the modal's heading and main's cannot differ. */
export { VLM_CONVERT_STAGE };
