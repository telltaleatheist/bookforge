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

/**
 * One listenable thing in the project. M4Bs play directly; EPUBs stream via
 * live TTS. The player is derived from what the user picks, so there is no
 * separate play/stream mode.
 */
interface ListenSource {
  id: string;
  type: 'mono-m4b' | 'bilingual-m4b' | 'epub';
  label: string;
  sublabel: string;
  /** Audio entries only: an EPUB is newer than this M4B */
  stale?: boolean;
  /** bilingual-m4b: key into item.bilingualOutputs */
  pairKey?: string;
  /** epub: absolute path to stream */
  epubPath?: string;
}

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
  imports: [CommonModule, AudiobookPlayerComponent, BilingualPlayerComponent, PlayViewComponent],
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
        <!-- Source picker -->
        <div class="source-bar">
          <button class="source-btn" (click)="pickerOpen.set(!pickerOpen())">
            <span class="source-icon">{{ selectedSource()?.type === 'epub' ? '📖' : '🎧' }}</span>
            <span class="source-label">{{ selectedSource()?.label || 'Choose source' }}</span>
            @if (selectedSource()?.stale) {
              <span class="stale-badge" title="An EPUB is newer than this audiobook — the book may have changed since it was produced">source changed</span>
            }
            <span class="caret">▾</span>
          </button>
          @if (pickerOpen()) {
            <div class="picker-backdrop" (click)="pickerOpen.set(false)"></div>
            <div class="picker-menu">
              @if (audioSources().length > 0) {
                <div class="picker-group">Audiobook</div>
                @for (s of audioSources(); track s.id) {
                  <button class="picker-item" [class.active]="s.id === selectedId()" (click)="selectSource(s)">
                    <span class="picker-icon">🎧</span>
                    <span class="picker-text">
                      <span class="picker-label">{{ s.label }}</span>
                      <span class="picker-sub">{{ s.sublabel }}</span>
                    </span>
                    @if (s.stale) {
                      <span class="stale-badge" title="An EPUB is newer than this audiobook — the book may have changed since it was produced">source changed</span>
                    }
                  </button>
                }
              }
              @if (epubSources().length > 0) {
                <div class="picker-group">Text — live TTS</div>
                @for (s of epubSources(); track s.id) {
                  <button class="picker-item" [class.active]="s.id === selectedId()" (click)="selectSource(s)">
                    <span class="picker-icon">📖</span>
                    <span class="picker-text">
                      <span class="picker-label">{{ s.label }}</span>
                      <span class="picker-sub">{{ s.sublabel }}</span>
                    </span>
                  </button>
                }
              }
            </div>
          }
        </div>

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
                />
              }
            } @else if (src.type === 'mono-m4b') {
              @if (bookAudioData(); as audio) {
                <app-audiobook-player [audiobook]="audio" [fullscreen]="true" (closeFullscreen)="closeWindow()" />
              }
            } @else {
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
    .source-bar {
      position: relative;
      display: flex; padding: 8px 16px; flex-shrink: 0;
    }
    .source-btn {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 14px; border: none; border-radius: 14px;
      background: var(--bg-elevated); color: var(--text-primary);
      font-size: 13px; cursor: pointer; transition: all 0.15s;
    }
    .source-btn:hover { background: color-mix(in srgb, var(--accent-primary, #06b6d4) 12%, var(--bg-elevated)); }
    .caret { font-size: 10px; color: var(--text-secondary); }
    .stale-badge {
      padding: 2px 8px; border-radius: 10px;
      background: color-mix(in srgb, #f59e0b 18%, transparent);
      color: #f59e0b; font-size: 10px; white-space: nowrap;
    }
    .picker-backdrop {
      position: fixed; inset: 0; z-index: 90;
    }
    .picker-menu {
      position: absolute; top: calc(100% + 2px); left: 16px; z-index: 91;
      min-width: 300px; max-height: 70vh; overflow-y: auto;
      background: var(--bg-elevated); border: 1px solid var(--border-default, rgba(255,255,255,0.1));
      border-radius: 10px; padding: 6px;
      box-shadow: 0 8px 30px rgba(0,0,0,0.45);
    }
    .picker-group {
      padding: 8px 10px 4px; font-size: 10px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--text-secondary);
    }
    .picker-item {
      display: flex; align-items: center; gap: 10px; width: 100%;
      padding: 8px 10px; border: none; border-radius: 8px;
      background: transparent; color: var(--text-primary);
      cursor: pointer; text-align: left; transition: background 0.12s;
    }
    .picker-item:hover { background: color-mix(in srgb, var(--accent-primary, #06b6d4) 10%, transparent); }
    .picker-item.active { background: color-mix(in srgb, var(--accent-primary, #06b6d4) 20%, transparent); }
    .picker-text { display: flex; flex-direction: column; gap: 1px; flex: 1; min-width: 0; }
    .picker-label { font-size: 13px; }
    .picker-sub { font-size: 11px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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

  readonly loading = signal(true);
  readonly projectPath = signal('');
  readonly item = signal<StudioItem | null>(null);
  readonly pickerOpen = signal(false);
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
    this.pickerOpen.set(false);
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
