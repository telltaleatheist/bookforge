import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { StudioService } from '../../services/studio.service';
import { LibraryService } from '../../../../core/services/library.service';
import { ElectronService } from '../../../../core/services/electron.service';
import { StudioItem, SUPPORTED_LANGUAGES } from '../../models/studio.types';
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
          <p>Nothing to listen to yet — import or export an EPUB, or run the Process pipeline first.</p>
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
              @if (bookAudioData(); as audio) {
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
    .player-area { flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .player-area > * { flex: 1; min-height: 0; }
    .state {
      flex: 1; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 12px;
      color: var(--text-secondary);
      padding: 24px; text-align: center;
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
export class ListenWindowComponent implements OnInit {
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
  private readonly scannedM4bs = signal<Array<{ fileName: string; mtimeMs: number }>>([]);

  readonly audioSources = computed<ListenSource[]>(() => {
    const it = this.item();
    if (!it) return [];
    const sources: ListenSource[] = [];
    const newestEpubMtime = Math.max(0, ...this.scannedEpubs().map(e => e.mtimeMs));
    const m4bMtime = (absPath: string): number | null => {
      const name = absPath.split('/').pop()?.split('\\').pop() ?? '';
      return this.scannedM4bs().find(m => m.fileName === name)?.mtimeMs ?? null;
    };
    const isStale = (audioPath: string): boolean => {
      const mtime = m4bMtime(audioPath);
      return mtime !== null && newestEpubMtime > mtime;
    };

    if (it.audiobookPath && it.vttPath) {
      sources.push({
        id: 'm4b:mono',
        type: 'mono-m4b',
        label: 'Audiobook',
        sublabel: this.basename(it.audiobookPath),
        stale: isStale(it.audiobookPath),
      });
    }
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
    if (!it || !it.audiobookPath || !it.vttPath) return null;
    return {
      id: it.id,
      title: it.title,
      author: it.author,
      audiobookPath: it.audiobookPath,
      vttPath: it.vttPath,
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
        const result = await this.electronService.listListenSources(item.bfpPath || project);
        if (result.success) {
          this.scannedEpubs.set(result.epubs ?? []);
          this.scannedM4bs.set(result.m4bs ?? []);
        }
        this.selectDefaultSource();
      }
    } finally {
      this.loading.set(false);
    }
  }

  /** Last-picked source if it still exists, else first audiobook, else first EPUB. */
  private selectDefaultSource(): void {
    const sources = this.sources();
    if (sources.length === 0) return;
    const remembered = localStorage.getItem(this.sourceStorageKey());
    if (remembered && sources.some(s => s.id === remembered)) {
      this.selectedId.set(remembered);
      return;
    }
    this.selectedId.set(sources[0].id);
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
