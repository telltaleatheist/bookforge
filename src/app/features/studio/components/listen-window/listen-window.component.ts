import { Component, inject, signal, computed, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { StudioService } from '../../services/studio.service';
import { LibraryService } from '../../../../core/services/library.service';
import { ElectronService } from '../../../../core/services/electron.service';
import { StudioItem, SUPPORTED_LANGUAGES } from '../../models/studio.types';
import { ResolvedProjectVariant } from '../../../../core/models/manifest.types';
import { AudiobookPlayerComponent } from '../audiobook-player/audiobook-player.component';
import { BilingualPlayerComponent } from '../../../language-learning/components/bilingual-player/bilingual-player.component';
import { PlayViewComponent } from '../../../audiobook/components/play-view/play-view.component';
import { ListenSourcePickerComponent, ListenSource } from '../listen-source-picker/listen-source-picker.component';
import { ListenProfilePickerComponent } from '../listen-profile-picker/listen-profile-picker.component';
import { ReaderService } from '../../../../core/services/reader.service';

/**
 * ListenWindowComponent - the dedicated player window (route /listen).
 *
 * Hosts playback for everything listenable in a project — finished M4Bs
 * (mono and bilingual) and live TTS streaming of any pipeline EPUB — in its
 * own window so listening continues while the user works in the main window.
 * The electron main process ties the stream TTS engine's lifetime to these
 * windows: closing the last one shuts the engine down.
 */
@Component({
  selector: 'app-listen-window',
  standalone: true,
  imports: [CommonModule, AudiobookPlayerComponent, BilingualPlayerComponent, PlayViewComponent, ListenSourcePickerComponent, ListenProfilePickerComponent],
  template: `
    <div class="listen-window">
      <!-- A failed variant read is reported, never quietly turned into "this book has
           no audiobooks" — but it does NOT block the rest of the window: the live-TTS
           EPUB sources are scanned separately and are still perfectly playable. -->
      @if (sources().length > 0 && variantError(); as err) {
        <div class="error-banner">
          <span>Some audiobooks may be missing from this list — {{ err }}</span>
        </div>
      }
      @if (loading()) {
        <div class="state">
          <div class="spinner"></div>
          <p>Loading…</p>
        </div>
      } @else if (!item()) {
        <div class="state">
          <p>Project not found.</p>
        </div>
      } @else if (sources().length === 0) {
        <div class="state">
          @if (variantError(); as err) {
            <p>This project's audiobooks could not be read, so none are listed:</p>
            <p class="missing-path">{{ err }}</p>
            <p>Close and reopen the Listen window to try again.</p>
          } @else {
            <p>Nothing to listen to yet — import or export an EPUB, or run the Process pipeline first.</p>
          }
        </div>
      } @else {
        <div class="player-area">
          @if (selectedSource(); as src) {
            @if (src.type === 'epub') {
              <!-- Tracked block so changing the EPUB recreates the stream view
                   (PlayView reads epubPath once at init and tears down its
                   stream in ngOnDestroy). -->
              @for (p of [src.epubPath!]; track p) {
                <app-play-view
                  [epubPath]="p"
                  [title]="item()!.title"
                  [author]="item()!.author || ''"
                  [coverSrc]="item()?.coverData ?? null"
                >
                  <app-listen-source-picker listen-source
                    [audioSources]="audioSources()" [epubSources]="epubSources()"
                    [selectedId]="selectedId()" (select)="selectSource($event)" />
                  <app-listen-profile-picker listen-profile />
                </app-play-view>
              }
            } @else if (src.type === 'mono-m4b') {
              @if (src.missingPath) {
                <!-- The manifest lists this audiobook but its file was not on disk
                     when the list was built. Say which file, and leave the picker
                     up so another source can be chosen. -->
                <div class="state">
                  <p>This audiobook can't be played — its file isn't on disk:</p>
                  <p class="missing-path">{{ src.missingPath }}</p>
                  <p>It may have been moved, deleted, or not yet synced to this machine.</p>
                  <app-listen-source-picker
                    [audioSources]="audioSources()" [epubSources]="epubSources()"
                    [selectedId]="selectedId()" (select)="selectSource($event)" />
                </div>
              } @else if (bookAudioData(); as audio) {
                <app-audiobook-player [audiobook]="audio" [coverSrc]="item()?.coverData ?? null" [fullscreen]="true" (closeFullscreen)="closeWindow()">
                  <app-listen-source-picker listen-source
                    [audioSources]="audioSources()" [epubSources]="epubSources()"
                    [selectedId]="selectedId()" (select)="selectSource($event)" />
                  <app-listen-profile-picker listen-profile />
                </app-audiobook-player>
              }
            } @else {
              <!-- Bilingual player has no shared chrome top bar, so the pickers
                   stay as a standalone bar above it. -->
              <div class="bilingual-source-bar">
                <app-listen-source-picker
                  [audioSources]="audioSources()" [epubSources]="epubSources()"
                  [selectedId]="selectedId()" (select)="selectSource($event)" />
                <app-listen-profile-picker />
              </div>
              @if (bilingualAudioData(); as audio) {
                <app-bilingual-player [audiobook]="audio" />
              }
            }
          }
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display: flex; flex-direction: column; height: 100%; min-height: 0; }
    .listen-window {
      display: flex; flex-direction: column;
      flex: 1; min-height: 0;
      background: var(--bg-base);
    }
    .bilingual-source-bar { padding: 8px 12px; flex-shrink: 0; }
    .error-banner {
      flex-shrink: 0; padding: 8px 12px;
      background: color-mix(in srgb, var(--warning) 16%, transparent);
      color: var(--text-primary); font-size: 12px;
    }
    .player-area { flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .player-area > * { flex: 1; min-height: 0; }
    .state {
      flex: 1; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 12px;
      color: var(--text-secondary);
      padding: 24px; text-align: center;
    }
    .missing-path {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px; color: var(--text-primary);
      max-width: 100%; overflow-wrap: anywhere;
    }
    .spinner {
      width: 32px; height: 32px;
      border: 3px solid var(--border-default);
      border-top-color: var(--accent-primary);
      border-radius: 50%;
      animation: spin 0.9s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  `]
})
export class ListenWindowComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly studioService = inject(StudioService);
  private readonly libraryService = inject(LibraryService);
  private readonly electronService = inject(ElectronService);
  private readonly readerService = inject(ReaderService);

  readonly loading = signal(true);
  readonly projectPath = signal('');
  readonly item = signal<StudioItem | null>(null);
  readonly selectedId = signal('');

  private readonly scannedEpubs = signal<Array<{ kind: string; lang?: string; path: string; mtimeMs: number }>>([]);
  private readonly scannedM4bs = signal<Array<{ fileName: string; path: string; vttPath?: string; mtimeMs: number }>>([]);
  // Audiobook variants (the single home for every M4B). Each with a synced-text
  // VTT becomes a selectable mono source, so ANY uploaded/produced audiobook is
  // listenable here — not just the project's registered outputs.audiobook.
  //
  // Rows arrive with their files ALREADY RESOLVED by the main process (absPath /
  // vttAbsPath, plus an existence flag for each). This window does no path
  // arithmetic: it used to join `variant.path` onto the project directory itself,
  // which is the defect fixed in the Versions panel — a manifest path is only
  // meaningful together with the project it was read from, and only main holds both
  // at once. See ResolvedProjectVariant.
  private readonly variants = signal<ResolvedProjectVariant[]>([]);
  /**
   * Set when `variant:list` answered with rows this window cannot trust — a variant
   * with no resolved `absPath`. That is a broken contract with the main process (an
   * out-of-date build), not "this book has no audiobooks", so it is reported instead
   * of being papered over by rebuilding the paths here.
   */
  readonly variantError = signal<string | null>(null);
  private unsubSelectAudio?: () => void;

  readonly audioSources = computed<ListenSource[]>(() => {
    const it = this.item();
    if (!it) return [];
    const sources: ListenSource[] = [];
    const newestEpubMtime = Math.max(0, ...this.scannedEpubs().map(e => e.mtimeMs));
    const m4bMtime = (absPath: string): number | null => {
      const name = this.basename(absPath);
      return this.scannedM4bs().find(m => m.fileName === name)?.mtimeMs ?? null;
    };
    const isStale = (audioPath: string): boolean => {
      const mtime = m4bMtime(audioPath);
      return mtime !== null && newestEpubMtime > mtime;
    };

    // Collect every mono audiobook, then sort newest-first so a just-produced
    // book is the default source (over the live-TTS EPUB rows that follow).
    const mono: Array<{ source: ListenSource; mtime: number }> = [];
    const coveredNames = new Set<string>();

    // One source per registered audiobook variant. Bilingual variants
    // (id `bilingual:<pair>`) are handled below via bilingualOutputs, which
    // carries the extra sentence-pairs data the bilingual player needs.
    for (const v of this.variants()) {
      if (v.kind !== 'audiobook' || v.id.startsWith('bilingual:')) continue;
      // main resolved this against the project it read the variant FROM, so it
      // cannot be another book's directory joined to this row.
      const audioAbs = v.absPath;
      coveredNames.add(this.basename(audioAbs));
      const label = (v.descriptor && v.descriptor.trim())
        ? `Audiobook — ${v.descriptor.trim()}`
        : 'Audiobook';
      mono.push({
        mtime: m4bMtime(audioAbs) ?? 0,
        source: {
          id: `variant:${v.id}`,
          type: 'mono-m4b',
          label,
          sublabel: this.basename(audioAbs),
          // A source whose file is gone is listed but not playable: `missingPath`
          // makes selecting it show WHICH file is missing instead of handing a
          // nonexistent path to the player, where it would surface as a mute player
          // or a decode error naming nothing.
          missingPath: v.exists ? undefined : audioAbs,
          stale: isStale(audioAbs),
          audiobookPath: audioAbs,
          // No VTT is fine — the audiobook plays audio-only (cover shown, chapters
          // from embedded markers). A vttPath recorded in the manifest whose file is
          // gone is NOT passed on: the player would fail its fetch and lose the
          // embedded-transcript route it would otherwise have taken.
          vttPath: v.vttExists && v.vttAbsPath ? v.vttAbsPath : undefined,
        },
      });
    }

    // Any M4B in output/ with no registered variant — e.g. an audiobook the
    // user just produced whose variant hasn't been recorded yet. Without this,
    // Listen would only offer the live-TTS EPUB and the finished book would be
    // unlistenable.
    for (const m of this.scannedM4bs()) {
      if (coveredNames.has(m.fileName) || m.fileName.startsWith('bilingual-')) continue;
      mono.push({
        mtime: m.mtimeMs,
        source: {
          id: `m4b:${m.fileName}`,
          type: 'mono-m4b',
          label: 'Audiobook',
          sublabel: m.fileName,
          stale: newestEpubMtime > m.mtimeMs,
          audiobookPath: m.path,
          vttPath: m.vttPath,
        },
      });
    }

    mono.sort((a, b) => b.mtime - a.mtime);
    for (const { source } of mono) sources.push(source);

    for (const [key, output] of Object.entries(it.bilingualOutputs ?? {})) {
      if (!output.audioPath || !output.vttPath) continue;
      sources.push({
        id: `m4b:${key}`,
        type: 'bilingual-m4b',
        label: `Bilingual ${key.toUpperCase().replace('-', '–')}`,
        sublabel: this.basename(output.audioPath),
        stale: isStale(output.audioPath),
        pairKey: key,
      });
    }
    return sources;
  });

  readonly epubSources = computed<ListenSource[]>(() => {
    const kindLabels: Record<string, string> = {
      translated: 'Translated',
      simplified: 'Simplified',
      cleaned: 'Cleaned',
      exported: 'Exported',
      original: 'Original',
    };
    return this.scannedEpubs().map(e => {
      let label = kindLabels[e.kind] ?? e.kind;
      if (e.lang) {
        const name = SUPPORTED_LANGUAGES.find(l => l.code === e.lang)?.name ?? e.lang.toUpperCase();
        label = `${label} (${name})`;
      }
      return {
        id: `epub:${e.path}`,
        type: 'epub' as const,
        label,
        sublabel: this.basename(e.path),
        epubPath: e.path,
      };
    });
  });

  readonly sources = computed<ListenSource[]>(() => [...this.audioSources(), ...this.epubSources()]);

  readonly selectedSource = computed<ListenSource | null>(() =>
    this.sources().find(s => s.id === this.selectedId()) ?? null
  );

  readonly bookAudioData = computed(() => {
    const it = this.item();
    const src = this.selectedSource();
    // Play the SELECTED audiobook variant's own files (not always the project's
    // first/registered one), so clicking Listen on any Audio row plays that book.
    // vttPath is optional — a no-VTT audiobook plays audio-only with its cover.
    if (!it || !src || src.type !== 'mono-m4b' || !src.audiobookPath) return null;
    // Never hand the player a file that wasn't there when the list was built. The
    // template shows the missing path instead (see the mono-m4b branch).
    if (src.missingPath) return null;
    return {
      id: it.id,
      title: it.title,
      author: it.author,
      audiobookPath: src.audiobookPath,
      vttPath: src.vttPath,
      epubPath: it.epubPath,
    };
  });

  readonly bilingualAudioData = computed(() => {
    const it = this.item();
    const key = this.selectedSource()?.pairKey;
    if (!it?.bilingualOutputs || !key) return null;
    const output = it.bilingualOutputs[key];
    if (!output?.audioPath || !output.vttPath) return null;
    return {
      id: it.id,
      title: it.title,
      sourceLang: output.sourceLang,
      targetLang: output.targetLang,
      audiobookPath: output.audioPath,
      vttPath: output.vttPath,
      sentencePairsPath: output.sentencePairsPath,
    };
  });

  async ngOnInit(): Promise<void> {
    const project = this.route.snapshot.queryParamMap.get('project') || '';
    this.projectPath.set(project);

    // Load reader profiles for the "who's listening" picker (non-blocking).
    void this.readerService.load();

    try {
      await this.libraryService.whenReady();
      await this.studioService.loadAll();
      const all = [...this.studioService.books(), ...this.studioService.articles()];
      const item = all.find(i => i.id === project || i.bfpPath === project) ?? null;
      this.item.set(item);

      if (item) {
        document.title = `Listen — ${item.title}`;
        // Load audiobook variants so every M4B (uploaded or produced) is selectable.
        // Each row must arrive with the absolute path main resolved for it; there is
        // no renderer-side way to rebuild one, so a row without it is reported rather
        // than guessed at (see variantError).
        try {
          const vr = await this.electronService.variantList(item.id);
          if (!vr.success || !vr.variants) {
            this.variantError.set(vr.error || 'variant:list failed without an error message.');
          } else {
            const unresolved = vr.variants.filter(v => !v.absPath);
            if (unresolved.length > 0) {
              this.variantError.set(
                `${unresolved.length} of this project's ${vr.variants.length} versions came back `
                + 'with no resolved file path (variant:list is expected to supply one). '
                + 'This is a bug — the main process may be from an older build.',
              );
            } else {
              this.variants.set(vr.variants);
            }
          }
        } catch (err) {
          this.variantError.set((err as Error).message);
        }
        const result = await this.electronService.listListenSources(item.bfpPath || project);
        if (result.success) {
          this.scannedEpubs.set(result.epubs ?? []);
          this.scannedM4bs.set(result.m4bs ?? []);
        }
        const target = this.route.snapshot.queryParamMap.get('audio');
        this.selectDefaultSource(target);
      }
    } finally {
      this.loading.set(false);
    }

    // If the player is already open when the user clicks Listen on a different
    // audiobook, the main process asks it to switch to that file.
    const electron = (window as any).electron;
    if (electron?.play?.onSelectAudio) {
      this.unsubSelectAudio = electron.play.onSelectAudio((audioPath: string) => {
        this.selectAudioByPath(audioPath);
      });
    }
  }

  ngOnDestroy(): void {
    this.unsubSelectAudio?.();
  }

  /** Select the audio source whose file matches the given absolute path. */
  private selectAudioByPath(audioPath: string): boolean {
    const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
    const match = this.audioSources().find(s => s.audiobookPath && norm(s.audiobookPath) === norm(audioPath));
    if (match) { this.selectSource(match); return true; }
    return false;
  }

  /**
   * Choose the initial source: the explicitly-requested audiobook (from the
   * Versions Audio row) if it resolves, else the last-picked source, else the
   * first audiobook, else the first EPUB.
   */
  private selectDefaultSource(targetAudioPath?: string | null): void {
    const sources = this.sources();
    if (sources.length === 0) return;
    // An EXPLICIT request is honoured even when the file is missing: the user clicked
    // Listen on that specific audiobook, so the right answer is the message naming
    // the file they asked for, not a silent switch to a different one.
    if (targetAudioPath && this.selectAudioByPath(targetAudioPath)) return;
    const remembered = localStorage.getItem(this.sourceStorageKey());
    if (remembered && sources.some(s => s.id === remembered)) {
      this.selectedId.set(remembered);
      return;
    }
    // Nothing was asked for, so open on something playable rather than landing the
    // user on a "file isn't on disk" screen when the project has working audio too.
    this.selectedId.set((sources.find(s => !s.missingPath) ?? sources[0]).id);
  }

  selectSource(source: ListenSource): void {
    this.selectedId.set(source.id);
    localStorage.setItem(this.sourceStorageKey(), source.id);
  }

  private sourceStorageKey(): string {
    return `bookforge-listen-source:${this.projectPath()}`;
  }

  private basename(p: string): string {
    return p.split('/').pop()?.split('\\').pop() ?? p;
  }

  closeWindow(): void {
    window.close();
  }
}
