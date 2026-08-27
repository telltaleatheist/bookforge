import { Injectable, inject, signal, computed, effect } from '@angular/core';
import { ElectronService } from '../../../core/services/electron.service';
import { LibraryService } from '../../../core/services/library.service';
import { StudioItem, StudioItemType, FetchUrlResult, EditAction } from '../models/studio.types';
import { SortField, SortPreference, DEFAULT_SORT, defaultDirectionFor, sortStudioItems } from '../models/studio-sort';
import type {
  AudiobookOutput, ArchiveEntry, AppliedPass, BookFamily,
} from '../../../core/models/manifest.types';
import { soleFamily } from '@shared/document/book-families';

const SORT_STORAGE_KEY = 'bookforge-studio-sort';

/**
 * StudioService - Unified project management for books and articles
 *
 * Manages both:
 * - Books: manifest project directories under {library}/projects/
 * - Articles: Language learning projects from ~/Documents/BookForge/language-learning/projects/
 */
@Injectable({
  providedIn: 'root'
})
export class StudioService {
  private readonly electronService = inject(ElectronService);
  private readonly libraryService = inject(LibraryService);

  // Reactive state
  private readonly _books = signal<StudioItem[]>([]);
  private readonly _articles = signal<StudioItem[]>([]);
  private readonly _archived = signal<StudioItem[]>([]);
  private readonly _loading = signal<boolean>(false);
  private readonly _error = signal<string | null>(null);

  // Active sort preference — shared by the Browse grid and Workspace list, and
  // persisted so it survives reloads and library switches.
  private readonly _sort = signal<SortPreference>(this.loadSortPref());
  readonly sort = computed(() => this._sort());

  // Public computed signals — ordered by the active sort so both views agree.
  // Books and articles each carry their own sortOrder space, so in Custom mode
  // they sort independently; the Browse grid groups them (books then articles).
  readonly books = computed(() => sortStudioItems(this._books(), this._sort()));
  readonly articles = computed(() => sortStudioItems(this._articles(), this._sort()));
  readonly archived = computed(() => sortStudioItems(this._archived(), this._sort()));
  readonly loading = computed(() => this._loading());
  readonly error = computed(() => this._error());

  // Combined count
  readonly totalCount = computed(() => this._books().length + this._articles().length);

  /**
   * A book another surface wants opened on its versions page.
   *
   * Studio selects from its own list, so there was no way to say "open THIS
   * book" from outside it — the route carries no project. The queue's completion
   * toast needs exactly that: click the news that a book finished and land on
   * that book. It is left HERE, as a request, rather than delivered to a
   * listener, because Studio may not be mounted when the toast is clicked — the
   * same reason the narration hand-off is left with a service.
   *
   * The id is a StudioItem id: a book's project directory, an article's manifest
   * id. Whoever consumes it TAKES it, so a second visit to Studio does not
   * re-open a book the user has since navigated away from.
   */
  private readonly _openRequest = signal<string | null>(null);
  readonly openRequest = this._openRequest.asReadonly();

  requestOpen(itemId: string): void {
    this._openRequest.set(itemId);
  }

  /** Read the pending request and clear it. Null when there is none. */
  takeOpenRequest(): string | null {
    const id = this._openRequest();
    if (id !== null) this._openRequest.set(null);
    return id;
  }

  private loadSortPref(): SortPreference {
    try {
      const raw = localStorage.getItem(SORT_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as SortPreference;
        if (parsed?.field && parsed?.direction) return parsed;
      }
    } catch { /* fall through to default */ }
    return { ...DEFAULT_SORT };
  }

  private persistSort(pref: SortPreference): void {
    try { localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(pref)); } catch { /* non-fatal */ }
  }

  /** Change the sort field, picking the direction that reads most naturally. */
  setSortField(field: SortField): void {
    const next: SortPreference = { field, direction: defaultDirectionFor(field) };
    this._sort.set(next);
    this.persistSort(next);
  }

  /** Flip ascending/descending. No-op in Custom (manual order has no direction). */
  toggleSortDirection(): void {
    const cur = this._sort();
    if (cur.field === 'custom') return;
    const next: SortPreference = { field: cur.field, direction: cur.direction === 'asc' ? 'desc' : 'asc' };
    this._sort.set(next);
    this.persistSort(next);
  }

  // Tracks the library path the loaded items belong to, so we can reload live
  // when the user switches library locations in Settings.
  private lastLibraryPath: string | null = null;

  // Bumped on every book load. Cover streaming outlives the load that started it,
  // so it checks this before publishing — otherwise a reload triggered mid-stream
  // (library switch, refresh) would have the previous library's covers written
  // over the new list.
  private loadGeneration = 0;

  /**
   * Bumped by every list load. `project:files-changed` arrives in storms — one
   * per write from every window and every queue job — and each one used to start
   * a fresh, uncancelled `loadBooks`. Whichever finished LAST published, which on
   * a busy filesystem is routinely an EARLIER snapshot than the one already on
   * screen; the stale flags it carries (hasTtsCache, audiobookPath) then decide
   * which destructive context-menu items appear. Same superseded shape as
   * studio-versions:3610 — an overtaken load reads its data and publishes none of
   * it.
   */
  private bookListGeneration = 0;
  private articleListGeneration = 0;

  constructor() {
    // Reload projects whenever the library location changes to a different
    // folder (e.g. the user picks a new library in Settings) so Studio updates
    // immediately instead of requiring an app restart. The initial null→path
    // load at startup is owned by the component's ngOnInit, so we only react to
    // genuine switches between two real locations.
    effect(() => {
      const path = this.libraryService.libraryPath();
      const prev = this.lastLibraryPath;
      this.lastLibraryPath = path;
      if (prev !== null && path !== null && path !== prev) {
        void this.loadAll();
      }
    });
  }

  /**
   * Load all items (books and articles)
   */
  async loadAll(): Promise<void> {
    this._loading.set(true);
    this._error.set(null);
    // `_archived` is NOT blanked here. Both halves replace their own type's
    // slice when they publish (publishBooks / loadArticles), so emptying it up
    // front bought nothing except a visible flicker on every refresh — and left
    // the Archived view empty for the whole duration of a slow load.

    try {
      await Promise.all([
        this.loadBooks(),
        this.loadArticles()
      ]);
    } catch (e) {
      this._error.set((e as Error).message);
    } finally {
      this._loading.set(false);
    }
  }

  /**
   * Load books from manifest projects
   */
  async loadBooks(): Promise<void> {
    if (!this.electronService.isRunningInElectron) {
      return;
    }

    // Phase timings go to the MAIN process log, not just the renderer console: a slow
    // book list happens at startup, before anyone has DevTools open, so the evidence
    // has to be written down as it happens or it's gone.
    const started = performance.now();
    const since = () => `${Math.round(performance.now() - started)}ms`;

    // True once a NEWER loadBooks has started. Everything below belongs to this
    // one's snapshot, so publishing after that point would put an older reading
    // of the library over a newer one.
    const generation = ++this.bookListGeneration;
    const superseded = () => generation !== this.bookListGeneration;

    try {
      const result = await this.electronService.manifestList({ type: 'book' });
      if (superseded()) return;
      if (!result.success || !result.projects) {
        // A failed envelope is not "no change". Silently returning made an IPC
        // failure — an unmounted library, a main process that died — read
        // exactly like a library that happens to hold the same books as before,
        // and the very next line of this function throws loudly for a missing
        // field. Say it in the same voice.
        this._error.set(result.error
          ?? 'The library could not be listed, and gave no reason. The books on screen may be out of date.');
        return;
      }
      this._error.set(null);
      this.logTiming(`[StudioService] manifests read: ${since()} (${result.projects.length} projects)`);

      // listProjects populates this for every project it returns. Its absence means the
      // main process is from a build that predates narration flags — surface that rather
      // than silently filing every book as "no audiobook".
      if (!result.narration) {
        throw new Error('manifestList returned no narration flags — main process out of date');
      }
      const narrationFlags = result.narration;

      // WHICH file the shelf's Process button narrates, per book. Derived by the
      // main process alongside the manifests, exactly as the narration flags are
      // — the renderer cannot resolve a variant's project-relative path without
      // joining a directory it must never join.
      //
      // The MAP must be present (a build that predates it is out of date, and is
      // said so in the same voice as the flags above); an ENTRY is optional and
      // its absence is the real answer "this book gets no button".
      if (!result.ttsTargets) {
        throw new Error('manifestList returned no TTS targets — main process out of date');
      }
      const ttsTargets = result.ttsTargets;

      const projectsPath = this.libraryService.projectsPath();
      if (!projectsPath) return;

      // Collect ALL file paths to check across ALL books in one batch IPC call
      const allPaths: string[] = [];
      const bookPathMaps: Array<{ manifest: any; projectDir: string; paths: Record<string, string> }> = [];

      // WHY THE `${projectDir}/${relative}` JOINS IN THIS LOOP ARE SAFE — and must
      // stay here rather than becoming an IPC round-trip per project.
      //
      // Elsewhere in the renderer, joining a manifest-relative path onto a project
      // directory is a bug: the directory comes from the live "selected book" signal
      // while the relative path comes from a row loaded earlier, so a selection change
      // pairs one book's folder with another book's file (the Versions-panel defect —
      // see ResolvedProjectVariant). None of that can happen here. `projectDir` is
      // derived from `manifest.projectId` on the very next line, so both halves of
      // every join below come from the SAME manifest object, in the same iteration,
      // with no await between them. There is no second project in scope to cross with.
      //
      // Resolving these in main instead would mean one IPC call per project — hundreds
      // at startup, on the slow path the batched fsBatchExists below exists to avoid —
      // to buy nothing. (Mixed `/` and `\` separators are fine: Node accepts both on
      // Windows, and the paths are only ever handed back to Node.)
      for (const manifest of result.projects) {
        const projectDir = `${projectsPath}/${manifest.projectId}`;
        const paths: Record<string, string> = {};

        // Standard audiobook
        if (manifest.outputs?.audiobook?.path) {
          paths['audiobook'] = `${projectDir}/${manifest.outputs.audiobook.path}`;
          if (manifest.outputs.audiobook.vttPath) {
            paths['vtt'] = `${projectDir}/${manifest.outputs.audiobook.vttPath}`;
          }
        }

        // Bilingual outputs
        if (manifest.outputs?.bilingualAudiobooks) {
          for (const [key, bilingual] of Object.entries(manifest.outputs.bilingualAudiobooks) as [string, AudiobookOutput][]) {
            paths[`bi-audio-${key}`] = `${projectDir}/${bilingual.path}`;
            if (bilingual.vttPath) {
              paths[`bi-vtt-${key}`] = `${projectDir}/${bilingual.vttPath}`;
            }
          }
        }

        // Cleanup. There is no `cleaned.epub`/`simplified.epub` to look for any
        // more: a pass rewrites the book EPUB in place, so what was done to it is
        // in manifest.outputs.epub.appliedPasses and nowhere else (see below).
        paths['skipped'] = `${projectDir}/stages/01-cleanup/skipped-chunks.json`;
        paths['cleanup-checkpoint'] = `${projectDir}/stages/01-cleanup/cleanup-progress.json`;

        // Analysis (completed report or in-progress checkpoint)
        paths['analysis'] = `${projectDir}/stages/04-analysis/analysis.json`;
        paths['analysis-checkpoint'] = `${projectDir}/stages/04-analysis/analysis-progress.json`;

        // Translation & TTS cache (directory existence + specific file)
        paths['translate-dir'] = `${projectDir}/stages/02-translate`;
        paths['translated-epub'] = `${projectDir}/stages/02-translate/translated.epub`;
        paths['tts-sessions-dir'] = `${projectDir}/stages/03-tts/sessions`;

        // Source files. New projects no longer keep a redundant source/original.*;
        // the pristine archive 'original' file IS the source. Legacy projects that
        // still have source/original.* keep working via the fallback below.
        // The export is named after the book, so the chain's own record is the
        // only thing that can point at it. listProjects() migrates pre-rename
        // projects before this runs, so an absent record means "never exported".
        //
        // A project with SEVERAL chains has no single "the book", and this scan
        // is a listing that cannot ask which — so it claims none rather than
        // picking one, and says so once on the console. The row is then a book
        // with no export, which is visibly incomplete; a guessed path would be
        // invisibly wrong, and the user would open the wrong version from it.
        const chain = soleFamily<BookFamily>(manifest.families ?? []);
        if (chain === null && (manifest.families ?? []).length > 1) {
          console.warn(
            `[StudioService] ${manifest.projectId} has ${manifest.families.length} working chains; `
            + 'this listing shows no book for it until the page can say which version it means.'
          );
        }
        // A project that still holds the LEGACY record has not been through the
        // migration yet, because `manifestList` is a pure read that deliberately
        // does the minimum at startup. Opening the project migrates it. Said out
        // loud rather than shown as a book with no export, which is what it
        // would otherwise look like — a gap nobody could account for.
        if (chain === null && manifest.outputs?.epub?.path) {
          console.warn(
            `[StudioService] ${manifest.projectId} still records its book at the pre-chain `
            + 'location, so this listing cannot place it. Opening the project moves it and the row '
            + 'is right from then on.'
          );
        }
        if (chain?.epub?.path) {
          paths['source-exported'] = `${projectDir}/${chain.epub.path}`;
        }
        paths['source-original'] = `${projectDir}/source/original.epub`;
        paths['source-pdf'] = `${projectDir}/source/original.pdf`;
        const archiveOriginal = (manifest.archive || []).find(
          (a: ArchiveEntry) => a.role === 'original' && a.format !== 'm4b',
        );
        if (archiveOriginal) paths['archive-original'] = `${projectDir}/${archiveOriginal.path}`;

        allPaths.push(...Object.values(paths));
        bookPathMaps.push({ manifest, projectDir, paths });
      }

      // Single IPC call to check all paths at once
      const existsMap = await this.electronService.fsBatchExists(allPaths);
      if (superseded()) return;
      this.logTiming(`[StudioService] stage probes: ${since()} (${allPaths.length} paths)`);

      // Build all book objects synchronously (no IPC needed — uses existsMap from batch check)
      const books = bookPathMaps.map(({ manifest, projectDir, paths }) => {
        const exists = (key: string) => !!existsMap[paths[key]];

        // Standard audiobook
        let audiobookPath: string | undefined;
        let vttPath: string | undefined;
        if (paths['audiobook'] && exists('audiobook')) {
          audiobookPath = paths['audiobook'];
          if (paths['vtt'] && exists('vtt')) {
            vttPath = paths['vtt'];
          }
        }

        // Bilingual outputs
        let bilingualAudioPath: string | undefined;
        let bilingualVttPath: string | undefined;
        let bilingualSentencePairsPath: string | undefined;
        const bilingualOutputs: Record<string, { audioPath: string; vttPath: string; sentencePairsPath?: string; sourceLang: string; targetLang: string }> = {};

        if (manifest.outputs?.bilingualAudiobooks) {
          for (const [key, bilingual] of Object.entries(manifest.outputs.bilingualAudiobooks) as [string, AudiobookOutput][]) {
            if (!exists(`bi-audio-${key}`)) continue;

            const absAudio = paths[`bi-audio-${key}`];
            const vttKey = `bi-vtt-${key}`;
            const vttExists = paths[vttKey] ? exists(vttKey) : false;
            const absVtt = paths[vttKey];
            const absPairs = bilingual.sentencePairsPath ? `${projectDir}/${bilingual.sentencePairsPath}` : undefined;

            const [src, tgt] = key.split('-');
            bilingualOutputs[key] = {
              audioPath: absAudio,
              vttPath: vttExists ? absVtt : absAudio.replace('.m4b', '.vtt'),
              sentencePairsPath: absPairs,
              sourceLang: src,
              targetLang: tgt,
            };

            if (!bilingualAudioPath) {
              bilingualAudioPath = absAudio;
              bilingualVttPath = vttExists ? absVtt : undefined;
              bilingualSentencePairsPath = absPairs;
            }
          }
        }

        // Cleanup state, from the book's own provenance.
        //
        // A pass writes the book EPUB in place, so "has this been cleaned?" has
        // no file to stat — the answer is whether a transforming pass is recorded
        // against `outputs.epub`. The stage copies this replaced are gone for the
        // mono pipeline, and scanning for them would have answered "no" for every
        // book processed by the pass pipeline.
        // Across EVERY chain, not the sole one. This is the same project-wide
        // provenance question `listPassDiffs` answers for the versions page's
        // badges, and the two must give the same answer: reading it through
        // `soleFamily` said "nothing has been done" for a project with two
        // archive EPUBs, while the diff listing beside it refused out loud.
        const appliedPasses = (manifest.families ?? [])
          .flatMap((f: BookFamily) => f.epub?.appliedPasses ?? []);
        const hasSimplified = appliedPasses.some((p: AppliedPass) => p.kind === 'simplify');
        // `detection` counts: it is the pass that turns a run directory into a
        // book, so a project carrying it has a processed EPUB even when the OCR
        // repair was skipped (a born-digital PDF needs no repairing).
        const hasCleaned = appliedPasses.some((p: AppliedPass) =>
          p.kind === 'simplify' || p.kind === 'ocr-correction'
          || p.kind === 'detection' || p.kind === 'footnotes');
        const hasCleanupCheckpoint = exists('cleanup-checkpoint');
        // The cleaned book IS the book. Kept as a separate field because callers
        // read it as "the processed EPUB", which is now the same file as epubPath.
        const cleanedEpubPath = hasCleaned && exists('source-exported')
          ? paths['source-exported']
          : undefined;

        let skippedChunksPath: string | undefined;
        if (hasCleaned && exists('skipped')) {
          skippedChunksPath = paths['skipped'];
        }

        // Translation state. The mono translate PASS rewrites the book in place,
        // so it shows up in provenance; the language-learning pipeline's
        // per-language EPUBs are genuinely different books and still live in
        // stages/02-translate. Both are real, which is why both are asked.
        const hasTranslatedPass = appliedPasses.some((p: AppliedPass) => p.kind === 'translate');
        const hasTranslated = hasTranslatedPass || exists('translate-dir');
        const translatedEpubPath = hasTranslatedPass && exists('source-exported')
          ? paths['source-exported']
          : (exists('translated-epub') ? paths['translated-epub'] : undefined);
        const hasTtsCache = exists('tts-sessions-dir');

        // Source file (priority order). EVERY candidate is one this batch just
        // stat'ed, so the answer is a file that is there — or null, meaning this
        // project genuinely has no source document. There is deliberately no
        // last-resort `${projectDir}/source/original.epub`: that path was invented,
        // not found, and it does not exist for 74 of 377 book projects in the
        // measured library (no archive role:'original', no source/original.*). It
        // made every one of those look like it had a document until something tried
        // to open it. See StudioItem.epubPath.
        let epubPath: string | null = null;
        if (exists('source-exported')) epubPath = paths['source-exported'];
        else if (exists('source-original')) epubPath = paths['source-original'];   // legacy projects
        else if (exists('source-pdf')) epubPath = paths['source-pdf'];             // legacy projects
        else if (paths['archive-original'] && exists('archive-original')) epubPath = paths['archive-original'];

        // Pristine source, opposite priority to epubPath: the raw import wins
        // over anything derived from it. Used by label mode, which must see the
        // same document OCR will see in production — which is why there is no
        // final `= epubPath` here either. A derived/exported EPUB is not the
        // scanned document, so standing it in would answer the wrong question
        // (and used to inherit epubPath's invented path along with it).
        let originalSourcePath: string | null = null;
        if (exists('source-pdf')) originalSourcePath = paths['source-pdf'];
        else if (paths['archive-original'] && exists('archive-original')) originalSourcePath = paths['archive-original'];
        else if (exists('source-original')) originalSourcePath = paths['source-original'];

        // Narration flags come from the main process, which derives them through the
        // real getVariants(). They are NOT re-derived here: outputs.audiobook and
        // manifest.variants overlap (an imported narration is recorded in both, pointing
        // at one m4b), and only getVariants knows to dedupe them by path before applying
        // each kind's default. Reading the raw fields separately — which this used to do —
        // applied two different defaults to a single audiobook and reported professional
        // imports as AI-narrated too.
        const narration = narrationFlags[manifest.projectId];

        const book: StudioItem = {
          id: projectDir,
          type: 'book',
          title: manifest.metadata?.title || manifest.projectId,
          author: manifest.metadata?.author,
          year: manifest.metadata?.year,
          language: manifest.metadata?.language,
          status: this.mapBookStatus(audiobookPath || bilingualAudioPath, hasCleaned),
          createdAt: manifest.createdAt,
          modifiedAt: manifest.modifiedAt,
          epubPath,
          originalSourcePath,
          // The record's file, only when it is really there. "Has this been
          // exported?" has no other answer — the file is named after the book.
          exportedEpubPath: exists('source-exported') ? paths['source-exported'] : null,
          // The chain that export is on, carried onto the row so the acts
          // offered from it can name the version they are about. Null for a
          // project this listing could not place — see `soleFamily` above,
          // which said so on the console when the paths were collected. Asked
          // again here rather than carried, because the collecting loop and this
          // mapping are two passes over the same manifests and the rule is pure.
          familyId: soleFamily<BookFamily>(manifest.families ?? [])?.id ?? null,
          // Import provenance, straight from the manifest — what this project was made
          // FROM, not what stage is selected now. The cleanup wizard defaults OCR repair
          // off this.
          sourceType: manifest.source?.type,
          projectDir,
          coverPath: manifest.metadata?.coverPath ? `${this.libraryService.libraryPath()}/${manifest.metadata.coverPath}` : undefined,
          coverRelPath: manifest.metadata?.coverPath,
          appliedPasses,
          hasCleaned,
          hasSimplified,
          hasCleanupCheckpoint,
          cleanedEpubPath,
          hasAnalysis: exists('analysis') || exists('analysis-checkpoint'),
          hasTranslated,
          translatedEpubPath,
          hasTtsCache,
          audiobookPath,
          vttPath,
          skippedChunksPath,
          // Absent for a book the shelf cannot name one file for. Left off the
          // row entirely rather than carried as a null, so the card's `@if` is
          // asking the same question the main process answered.
          ttsTarget: ttsTargets[manifest.projectId],
          hasProfessionalNarration: narration.professional,
          hasAiNarration: narration.ai,
          bilingualAudioPath,
          bilingualVttPath,
          bilingualSentencePairsPath,
          bilingualOutputs: Object.keys(bilingualOutputs).length > 0 ? bilingualOutputs : undefined,
          outputFilename: manifest.metadata?.outputFilename,
          contributors: manifest.metadata?.contributors,
          tags: manifest.metadata?.tags,
          archived: manifest.archived,
          sortOrder: manifest.sortOrder,
          archiveCount: manifest.archive?.length || 0,
        };

        return book;
      });

      // PUBLISH FIRST. Everything above is manifest data that's already in hand;
      // covers are hundreds of separate image reads against a synced library and
      // used to run BEFORE this line — so the entire list stayed invisible for as
      // long as the slowest cover took, which on a busy filesystem is the "why is
      // the book list taking forever" wait. The list now appears as soon as the
      // metadata is parsed, and covers fill in underneath it.
      this.publishBooks(books);
      this.logTiming(`[StudioService] LIST VISIBLE: ${since()} (${books.length} books)`);

      // Covers stream in afterwards. Deliberately NOT awaited: loadAll()'s caller
      // uses its promise to clear the loading spinner, and the list is complete
      // without covers.
      void this.streamCovers(books, bookPathMaps).then(() =>
        this.logTiming(`[StudioService] covers complete: ${since()}`));
    } catch (e) {
      console.error('[StudioService] Failed to load books:', e);
      if (!superseded()) this._error.set((e as Error).message);
    }
  }

  /** Record a startup phase timing in the main-process log (and the dev console). */
  private logTiming(message: string): void {
    console.log(message);
    (window as any).electron?.debug?.log?.(message);
  }

  /** Split books into active/archived and push both signals. */
  private publishBooks(books: StudioItem[]): void {
    this._books.set(books.filter(b => !b.archived));
    // Merge archived books into the archived signal (combined with archived articles)
    this._archived.update(existing => [
      ...existing.filter(i => i.type !== 'book'),
      ...books.filter(b => b.archived),
    ]);
  }

  /**
   * Fetch cover thumbnails and fold them into the already-visible list.
   *
   * Chunked so covers appear progressively rather than all at the end, and each
   * chunk is ONE IPC call (the main process runs its own worker pool) instead of one
   * call per cover — the old shape made hundreds of round-trips and forced a barrier
   * every ten covers, so one slow read stalled nine ready ones.
   *
   * Each chunk replaces the affected item OBJECTS rather than mutating them: the list
   * is rendered from a signal with `track item.id`, and an in-place `book.coverData =`
   * changes nothing Angular can see.
   */
  private async streamCovers(
    books: StudioItem[],
    bookPathMaps: Array<{ manifest: any; projectDir: string; paths: Record<string, string> }>,
  ): Promise<void> {
    const generation = ++this.loadGeneration;

    const coverPathById = new Map<string, string>();
    for (const { manifest, projectDir } of bookPathMaps) {
      const coverPath = manifest.metadata?.coverPath;
      if (coverPath) coverPathById.set(projectDir, coverPath);
    }

    const pending = books.filter(b => coverPathById.has(b.id));
    if (pending.length === 0) return;

    const CHUNK = 40;
    const withCovers = new Map<string, string>();

    for (let i = 0; i < pending.length; i += CHUNK) {
      // A library switch (or any reload) started while this was in flight — its
      // covers belong to a list that is no longer on screen.
      if (generation !== this.loadGeneration) return;

      const chunk = pending.slice(i, i + CHUNK);
      const paths = chunk.map(b => coverPathById.get(b.id)!);

      try {
        // List/grid only need a small thumbnail — serving full-res covers here held
        // ~354MB of base64 in renderer memory across the collection. The metadata
        // editor loads the full-res cover on demand (see StudioComponent).
        const result = await this.electronService.mediaLoadImages(paths, 200);
        if (!result.success || !result.data) continue;

        for (const book of chunk) {
          const data = result.data[coverPathById.get(book.id)!];
          if (data) withCovers.set(book.id, data);
        }
      } catch (err) {
        console.warn('[StudioService] Cover batch failed:', err);
        continue;
      }

      if (generation !== this.loadGeneration) return;

      // Fold covers into whatever the signals hold RIGHT NOW rather than re-publishing
      // the snapshot this stream started from — the user can archive, rename or reorder
      // while covers are still arriving, and rebuilding from the old array would silently
      // undo it. Only coverData is touched; every other field is left as found.
      const applyCovers = (items: StudioItem[]): StudioItem[] => items.map(item => {
        const data = withCovers.get(item.id);
        return data && item.coverData !== data ? { ...item, coverData: data } : item;
      });
      this._books.update(applyCovers);
      this._archived.update(applyCovers);
    }
  }

  /**
   * Load articles from manifest projects
   */
  async loadArticles(): Promise<void> {
    if (!this.electronService.isRunningInElectron) {
      return;
    }

    // Same superseded rule as loadBooks — the files-changed storm reaches both.
    const generation = ++this.articleListGeneration;
    const superseded = () => generation !== this.articleListGeneration;

    try {
      const result = await this.electronService.manifestList({ type: 'article' });
      if (superseded()) return;
      if (!result.success || !result.projects) {
        this._error.set(result.error
          ?? 'The library could not be listed, and gave no reason. The articles on screen may be out of date.');
        return;
      }
      this._error.set(null);

      // WHICH file a Process press on this article narrates — main's answer,
      // the same one books get and computed for every project it returns. It is
      // read here because an article's Finalize opens the narration modal on
      // it: without it that door would have to pick a version itself, which is
      // a second rule for "which file does a run read" and the wrong kind of
      // second. A missing MAP is an out-of-date main process, said in the same
      // voice loadBooks says it; a missing ENTRY is the real answer "this
      // article has no EPUB to narrate yet".
      if (!result.ttsTargets) {
        throw new Error('manifestList returned no TTS targets — main process out of date');
      }
      const ttsTargets = result.ttsTargets;

      const projectsPath = this.libraryService.projectsPath();
      if (!projectsPath) return;

      // Collect all paths for batch existence check
      const allPaths: string[] = [];
      const articlePathMaps: Array<{ manifest: any; projectDir: string; paths: Record<string, string> }> = [];

      for (const manifest of result.projects) {
        const projectDir = `${projectsPath}/${manifest.projectId}`;
        const paths: Record<string, string> = {
          // Located by its chain's own record — the export is named after the
          // book. A project with several chains claims none here, for the reason
          // spelled out in loadBooks above.
          ...(soleFamily<BookFamily>(manifest.families ?? [])?.epub?.path
            ? {
              'source-exported':
                `${projectDir}/${soleFamily<BookFamily>(manifest.families)!.epub!.path}`,
            }
            : {}),
          'source-original': `${projectDir}/source/original.epub`,
          'source-pdf': `${projectDir}/source/original.pdf`,
        };
        allPaths.push(...Object.values(paths));
        articlePathMaps.push({ manifest, projectDir, paths });
      }

      // Single IPC call for all articles
      const existsMap = await this.electronService.fsBatchExists(allPaths);
      if (superseded()) return;

      // ── The article editor's state, from its own file ──────────────────────
      //
      // `manifest.editor` is gone: editor state is a per-project sidecar
      // (electron/editor-state-store.ts) precisely so the catalog does not carry
      // it. An article's is small — deleted selectors and two history stacks —
      // and only articles need it here, so it is fetched per article, in
      // parallel, rather than by putting the key back on the list result and
      // making every BOOK's OCR blocks travel with it again.
      const editorStates = new Map<string, any>();
      await Promise.all(articlePathMaps.map(async ({ manifest }) => {
        const result = await this.electronService.manifestGetEditorState(manifest.projectId);
        if (!result.success) {
          // Loudly, and not papered over with an empty set: an article whose
          // saved deletions could not be read must not be shown as an article
          // with no deletions, because the editor would then save that back.
          console.error(
            `[StudioService] ${manifest.projectId}: could not read its editor state — `
            + `${result.error}`);
          return;
        }
        if (result.editor) editorStates.set(manifest.projectId, result.editor);
      }));
      if (superseded()) return;

      const articles: StudioItem[] = articlePathMaps.map(({ manifest, projectDir, paths }) => {
        const editor = editorStates.get(manifest.projectId);
        const exists = (key: string) => !!existsMap[paths[key]];

        // Same provenance rule as books — see loadBooks.
        const chain = soleFamily<BookFamily>(manifest.families ?? []);
        // Provenance across every chain — see loadBooks for why this one is not
        // read off `chain`.
        const appliedPasses = (manifest.families ?? [])
          .flatMap((f: BookFamily) => f.epub?.appliedPasses ?? []);
        // `detection` counts: it is the pass that turns a run directory into a
        // book, so a project carrying it has a processed EPUB even when the OCR
        // repair was skipped (a born-digital PDF needs no repairing).
        const hasCleaned = appliedPasses.some((p: AppliedPass) =>
          p.kind === 'simplify' || p.kind === 'ocr-correction'
          || p.kind === 'detection' || p.kind === 'footnotes');
        const hasAudiobook = !!manifest.outputs?.audiobook?.path;
        let status: StudioItem['status'] = 'draft';
        if (hasAudiobook) status = 'completed';
        else if (hasCleaned) status = 'ready';

        // Same rule as books: a path only if a file was found. An article that has
        // been fetched but not yet finalized has no EPUB at all, and the invented
        // `${projectDir}/source/original.epub` that used to be handed back described
        // one that had never been written.
        let articleEpubPath: string | null = null;
        if (exists('source-exported')) articleEpubPath = paths['source-exported'];
        else if (exists('source-original')) articleEpubPath = paths['source-original'];
        else if (exists('source-pdf')) articleEpubPath = paths['source-pdf'];

        return {
          id: manifest.projectId,
          type: 'article' as const,
          title: manifest.metadata?.title || 'Untitled',
          author: manifest.metadata?.author || manifest.metadata?.byline,
          status,
          createdAt: manifest.createdAt,
          modifiedAt: manifest.modifiedAt,
          sourceUrl: manifest.source?.url,
          sourceLang: manifest.metadata?.language || 'en',
          byline: manifest.metadata?.byline,
          excerpt: manifest.metadata?.excerpt,
          wordCount: manifest.metadata?.wordCount,
          epubPath: articleEpubPath,
          exportedEpubPath: exists('source-exported') ? paths['source-exported'] : null,
          // As in loadBooks: the chain the export is on, or null when this
          // listing could not say which version the project means.
          familyId: chain?.id ?? null,
          // Articles have no pristine imported document: they are fetched HTML, and
          // the HTML lives in htmlPath. Explicitly null rather than borrowing
          // epubPath, which would name a derived EPUB.
          originalSourcePath: null,
          projectDir,
          htmlPath: `${projectDir}/source/article.html`,
          deletedSelectors: editor?.deletedSelectors || [],
          undoStack: (editor?.undoStack as EditAction[] | undefined) || [],
          redoStack: (editor?.redoStack as EditAction[] | undefined) || [],
          appliedPasses,
          hasCleaned,
          // Absent for an article main cannot name one file for — left off the
          // row entirely rather than carried as a null, as on books.
          ttsTarget: ttsTargets[manifest.projectId],
          archived: manifest.archived,
          sortOrder: manifest.sortOrder,
        };
      });

      // Separate archived articles (ordering is applied by the articles/archived
      // computeds via the active sort preference)
      const activeArticles = articles.filter(a => !a.archived);
      const archivedArticles = articles.filter(a => a.archived);

      this._articles.set(activeArticles);
      // Merge archived articles into the archived signal (combined with archived books)
      this._archived.update(existing => {
        const withoutArticles = existing.filter(i => i.type !== 'article');
        return [...withoutArticles, ...archivedArticles];
      });
    } catch (e) {
      console.error('[StudioService] Failed to load articles:', e);
      if (!superseded()) this._error.set((e as Error).message);
    }
  }

  /**
   * Map book project state to unified status
   * @param audiobookPath - The resolved audiobook path (computed during loading)
   * @param hasCleaned - Whether the book has been through AI cleanup
   */
  private mapBookStatus(audiobookPath?: string, hasCleaned?: boolean): StudioItem['status'] {
    if (audiobookPath) return 'completed';
    if (hasCleaned) return 'ready';
    return 'draft';
  }

  /**
   * Get a single item by ID
   */
  getItem(id: string): StudioItem | undefined {
    return this._books().find(b => b.id === id) ||
           this._articles().find(a => a.id === id) ||
           this._archived().find(a => a.id === id);
  }

  /**
   * Add book from EPUB file
   * Creates a project directory and output folder for the EPUB
   */
  async addBook(epubPath: string, metadata?: { title: string; author: string; year?: string; language?: string; coverData?: string }): Promise<{ success: boolean; item?: StudioItem; error?: string }> {
    if (!this.electronService.isRunningInElectron) {
      return { success: false, error: 'Not running in Electron' };
    }

    try {
      // Import EPUB - this creates the project directory and output folder
      const result = await this.electronService.audiobookImportEpub(epubPath, metadata);

      if (!result.success) {
        return { success: false, error: result.error || 'Failed to import EPUB' };
      }

      // Reload books to get the new item
      await this.loadBooks();

      // Find the newly added book by project directory. loadBooks() builds it with
      // forward slashes (`${projectsPath}/${projectId}`) while the importer returns
      // path.join(...) — backslashes on Windows — so compare separator-normalized.
      const norm = (p?: string) => p?.replace(/\\/g, '/');
      const newBook = this._books().find(b => norm(b.projectDir) === norm(result.projectPath));

      if (newBook) {
        return { success: true, item: newBook };
      }

      // If we can't find it specifically, return success and let the UI refresh
      return { success: true };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }

  /**
   * Import an existing audio file (m4b/mp3/wav/…) as a complete audiobook project.
   * Creates the project, normalizes the audio to m4b, and marks it complete so it
   * appears on the grid + Bookshelf like a generated book.
   */
  async importAudiobook(audioPath: string): Promise<{ success: boolean; item?: StudioItem; error?: string; duplicate?: boolean; existingTitle?: string }> {
    if (!this.electronService.isRunningInElectron) {
      return { success: false, error: 'Not running in Electron' };
    }
    try {
      const result = await this.electronService.audiobookImportAudiobook(audioPath);
      if (!result.success) {
        return { success: false, error: result.error || 'Failed to import audiobook', duplicate: result.duplicate, existingTitle: result.existingTitle };
      }
      await this.loadBooks();
      const norm = (p?: string) => p?.replace(/\\/g, '/');
      const newBook = this._books().find(b => norm(b.projectDir) === norm(result.projectPath));
      return newBook ? { success: true, item: newBook } : { success: true };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }

  /**
   * Add article from URL
   */
  async addArticle(url: string): Promise<{ success: boolean; item?: StudioItem; warning?: string; error?: string }> {
    if (!this.electronService.isRunningInElectron) {
      return { success: false, error: 'Not running in Electron' };
    }

    try {
      // Fetch URL content
      const result = await this.electronService.languageLearningFetchUrl(url);

      if (!result.success) {
        return { success: false, error: result.error || 'Failed to fetch URL' };
      }

      // Create a proper manifest project so the article survives loadArticles() reloads
      const createResult = await this.electronService.manifestCreate('article', {
        type: 'url',
        url,
        fetchedAt: new Date().toISOString(),
        originalFilename: 'article.html',
      }, {
        title: result.title || 'Untitled',
        author: result.byline,
        byline: result.byline,
        excerpt: result.excerpt,
        wordCount: result.wordCount,
        language: 'en',
      });

      if (!createResult.success || !createResult.projectPath) {
        return { success: false, error: createResult.error || 'Failed to create project' };
      }

      // Copy the fetched HTML into the manifest project's source directory
      if (result.htmlPath) {
        const htmlContent = await this.electronService.readTextFile(result.htmlPath);
        if (htmlContent) {
          await this.electronService.writeTextFile(
            `${createResult.projectPath}/source/article.html`,
            htmlContent
          );
        }
      }

      const projectId = createResult.projectId!;
      const article: StudioItem = {
        id: projectId,
        type: 'article',
        title: result.title || 'Untitled',
        author: result.byline,
        status: 'draft',
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        sourceUrl: url,
        // A just-fetched article has HTML and nothing else — no EPUB has been written
        // yet (that happens when the content is finalized) and there is no imported
        // document. Both are null until loadArticles() finds real files.
        epubPath: null,
        originalSourcePath: null,
        exportedEpubPath: null,
        // A just-created project has no working chain either — one is minted the
        // first time anything asks about its book.
        familyId: null,
        htmlPath: `${createResult.projectPath}/source/article.html`,
        deletedSelectors: [],
        sourceLang: 'en',
        targetLang: 'de',
        byline: result.byline,
        excerpt: result.excerpt,
        wordCount: result.wordCount,
        projectDir: createResult.projectPath,
      };

      // Add to local state
      this._articles.update(articles => [...articles, article]);

      // Pass through partial-extraction warnings (load timeout / unsolved captcha)
      // so the UI can surface them — the article text may be incomplete.
      return { success: true, item: article, warning: result.warning };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }

  /**
   * Update article (for content editing)
   */
  async updateArticle(
    id: string,
    updates: {
      deletedSelectors?: string[];
      undoStack?: EditAction[];
      redoStack?: EditAction[];
      targetLang?: string;
    }
  ): Promise<{ success: boolean; error?: string }> {
    const article = this._articles().find(a => a.id === id);
    if (!article) {
      return { success: false, error: 'Article not found' };
    }

    try {
      const updated: StudioItem = {
        ...article,
        ...updates,
        modifiedAt: new Date().toISOString()
      };

      // Persist editor state to the unified manifest FIRST so a failed write
      // (e.g. EBUSY on a synced drive) can't masquerade as a saved edit that
      // silently reverts on reload.
      const saveResult = await this.electronService.manifestUpdate({
        projectId: id,
        editor: {
          deletedSelectors: updated.deletedSelectors || [],
          undoStack: updated.undoStack || [],
          redoStack: updated.redoStack || [],
        },
      });

      // Mirror into local state only once the save succeeded
      if (saveResult.success) {
        this._articles.update(articles =>
          articles.map(a => a.id === id ? updated : a)
        );
      }

      return { success: saveResult.success, error: saveResult.error };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }

  /**
   * Delete an item (book or article)
   * For books: deletes the project directory and clears the render cache
   * For articles: deletes project folder
   */
  async deleteItem(id: string): Promise<{ success: boolean; error?: string }> {
    const book = this._books().find(b => b.id === id);
    const article = this._articles().find(a => a.id === id);
    const archivedItem = this._archived().find(a => a.id === id);

    const item = book || article || archivedItem;
    if (!item) return { success: false, error: 'Item not found' };

    try {
      const projectId = this.resolveProjectId(item);
      const result = await this.electronService.manifestDelete(projectId);
      if (result.success) {
        this._books.update(books => books.filter(b => b.id !== id));
        this._articles.update(articles => articles.filter(a => a.id !== id));
        this._archived.update(items => items.filter(i => i.id !== id));
      }
      return result;
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }

  /**
   * Reload a specific item
   */
  async reloadItem(id: string): Promise<void> {
    const book = this._books().find(b => b.id === id);
    const article = this._articles().find(a => a.id === id);

    if (book) {
      await this.loadBooks();
    } else if (article) {
      await this.loadArticles();
    }
  }

  /**
   * Update book metadata (saves to the manifest and updates local state)
   */
  async updateBookMetadata(
    id: string,
    metadata: {
      title?: string;
      author?: string;
      year?: string;
      language?: string;
      coverPath?: string;
      coverData?: string;
      outputFilename?: string;
      contributors?: Array<{ first: string; last: string }>;
      tags?: string[];
      slug?: string;
    }
  ): Promise<{ success: boolean; error?: string; warnings?: string[] }> {
    const book = this._books().find(b => b.id === id);
    if (!book || !book.projectDir) {
      return { success: false, error: 'Book not found' };
    }

    try {
      // Save to the manifest
      const result = await this.electronService.projectUpdateMetadata(book.projectDir, metadata);

      if (!result.success) {
        return result;
      }

      // Update local state immediately with all metadata fields
      const newProjectDir = result.newProjectDir;
      // The main process stored the cover under a fresh content-hashed name in
      // media/ and told us where. Adopt it: coverRelPath is what the editor's
      // full-res loader reads, so leaving it stale (or unset, for a book that had
      // no cover) makes a just-saved cover read back as "no cover" and blank out.
      const coverRelPath = result.coverPath;
      const coverAbsPath = coverRelPath
        ? `${this.libraryService.libraryPath()}/${coverRelPath}`
        : undefined;
      this._books.update(books =>
        books.map(b => b.id === id ? {
          ...b,
          title: metadata.title ?? b.title,
          author: metadata.author ?? b.author,
          year: metadata.year ?? b.year,
          language: metadata.language ?? b.language,
          coverData: metadata.coverData ?? b.coverData,
          ...(coverRelPath ? { coverRelPath, coverPath: coverAbsPath } : {}),
          outputFilename: metadata.outputFilename ?? b.outputFilename,
          contributors: metadata.contributors ?? b.contributors,
          tags: metadata.tags ?? b.tags,
          modifiedAt: new Date().toISOString(),
          // Update projectDir and id if project folder was renamed
          ...(newProjectDir ? { projectDir: newProjectDir, id: newProjectDir } : {})
        } : b)
      );

      // Pass through per-file embed warnings (EPUB/M4B cover+metadata failures)
      // so the UI can tell the user which files kept stale data.
      return { success: true, warnings: result.warnings };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }

  /**
   * Finalize article content for processing
   * Saves the filtered HTML and marks content as finalized
   */
  async finalizeArticleContent(
    id: string,
    finalizedHtml: string
  ): Promise<{ success: boolean; error?: string }> {
    const article = this._articles().find(a => a.id === id);
    if (!article) {
      return { success: false, error: 'Article not found' };
    }

    try {
      // Save finalized content using IPC handler
      const result = await this.electronService.languageLearningFinalizeContent(
        id,
        finalizedHtml
      );

      if (!result.success) {
        return { success: false, error: result.error || 'Failed to finalize content' };
      }

      // Update local state
      this._articles.update(articles =>
        articles.map(a => a.id === id ? {
          ...a,
          contentFinalized: true,
          modifiedAt: new Date().toISOString()
        } : a)
      );

      return { success: true };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }

  /**
   * Archive one or more items (move to Archived section)
   */
  async archiveItems(ids: string[]): Promise<void> {
    for (const id of ids) {
      const item = this.getItem(id);
      if (!item) continue;
      const projectId = this.resolveProjectId(item);
      await this.electronService.manifestUpdate({ projectId, archived: true });
    }
    await this.loadAll();
  }

  /**
   * Re-classify items as books or articles.
   *
   * Studio's Books/Articles split, the Bookshelf's Ebooks/Articles split and
   * `manifestList({type})` all read the manifest's ONE `projectType` field, so
   * this only flips that tag — no file moves, nothing is rewritten. It exists
   * because the classification is decided at import (a PDF dropped through an
   * article path, say) and was until now unfixable from the app.
   *
   * Returns the ids of items that changed, in their POST-conversion form: a
   * book's StudioItem id is its project directory and an article's is its
   * manifest id, so a converted item's id is not the one that was passed in.
   */
  async setItemType(ids: string[], type: StudioItemType): Promise<string[]> {
    const converted: string[] = [];
    for (const id of ids) {
      const item = this.getItem(id);
      if (!item || item.type === type) continue;
      const projectId = this.resolveProjectId(item);
      const result = await this.electronService.manifestUpdate({ projectId, projectType: type });
      if (!result.success) {
        console.error(`[StudioService] Failed to re-classify ${projectId}:`, result.error);
        continue;
      }
      converted.push(type === 'book' ? (item.projectDir || id) : projectId);
    }
    if (converted.length > 0) await this.loadAll();
    return converted;
  }

  /**
   * Unarchive one or more items (move back to their original sections)
   */
  async unarchiveItems(ids: string[]): Promise<void> {
    for (const id of ids) {
      const item = this._archived().find(i => i.id === id);
      if (!item) continue;
      const projectId = this.resolveProjectId(item);
      await this.electronService.manifestUpdate({ projectId, archived: false });
    }
    await this.loadAll();
  }

  /**
   * Reorder items within a section by assigning each a sequential sortOrder.
   *
   * orderedIds may be a subset of the section (e.g. a search/tag filter is
   * active, or the Browse grid reorders only one type): items not referenced
   * keep their existing slots, and only the referenced items are reshuffled
   * among those slots. Then the whole section is renumbered so the custom order
   * is a clean 0..n sequence, and only the items whose sortOrder actually
   * changed are persisted.
   */
  async reorderItems(section: 'articles' | 'books' | 'archived', orderedIds: string[]): Promise<void> {
    const items = section === 'articles' ? this._articles()
      : section === 'books' ? this._books()
      : this._archived();

    // Reorder referenced items within their existing positions, leaving any
    // unreferenced (filtered-out) items where they are.
    const referencedSet = new Set(orderedIds);
    const queue = orderedIds
      .map(id => items.find(i => i.id === id))
      .filter((i): i is StudioItem => !!i);
    let qi = 0;
    const merged = items.map(item => (referencedSet.has(item.id) ? queue[qi++] : item));

    // Renumber the full section and remember which items changed.
    const changed: StudioItem[] = [];
    const withOrder = merged.map((item, idx) => {
      if (item.sortOrder === idx) return item;
      const updated = { ...item, sortOrder: idx };
      changed.push(updated);
      return updated;
    });

    if (section === 'articles') this._articles.set(withOrder);
    else if (section === 'books') this._books.set(withOrder);
    else this._archived.set(withOrder);

    // Persist only the items whose sortOrder moved.
    for (const item of changed) {
      const projectId = this.resolveProjectId(item);
      await this.electronService.manifestUpdate({ projectId, sortOrder: item.sortOrder });
    }
  }

  /**
   * Resolve the manifest projectId from a StudioItem.
   * Books use the project directory as id, but manifest needs the folder name (UUID).
   */
  private resolveProjectId(item: StudioItem): string {
    if (item.type === 'article') return item.id;
    // For books, item.id is the absolute project dir path — extract the folder name
    const parts = item.id.split('/');
    return parts[parts.length - 1];
  }

}
