import { Component, inject, signal, computed, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { StudioService } from '../../services/studio.service';
import { LibraryService } from '../../../../core/services/library.service';
import { ElectronService } from '../../../../core/services/electron.service';
import { StudioItem } from '../../models/studio.types';
import { AudiobookPlayerComponent } from '../audiobook-player/audiobook-player.component';
import { BilingualPlayerComponent } from '../../../language-learning/components/bilingual-player/bilingual-player.component';
import { PlayViewComponent } from '../../../audiobook/components/play-view/play-view.component';

/**
 * ListenWindowComponent - the dedicated player window (route /listen).
 *
 * Hosts both Listen modes — Play (finished M4B / bilingual audiobooks) and
 * Stream (live TTS preview) — in their own window so listening continues
 * while the user works in the main window. The electron main process ties
 * the stream TTS engine's lifetime to these windows: closing the last one
 * shuts the engine down.
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
      } @else {
        <!-- Mode toggle -->
        <div class="mode-bar">
          <button class="mode-btn" [class.active]="mode() === 'play'"
            [class.disabled]="!hasAudio()"
            (click)="hasAudio() ? mode.set('play') : null">Play</button>
          <button class="mode-btn" [class.active]="mode() === 'stream'"
            [class.disabled]="!epubPath()"
            (click)="epubPath() ? mode.set('stream') : null">Stream (preview)</button>
        </div>

        <div class="player-area">
          @if (mode() === 'stream') {
            @if (epubPath()) {
              <app-play-view
                [epubPath]="epubPath()"
                [title]="item()!.title"
                [author]="item()!.author || ''"
              />
            } @else {
              <div class="state"><p>No EPUB available to stream.</p></div>
            }
          } @else {
            @if (bookAudioData(); as audio) {
              <app-audiobook-player [audiobook]="audio" [fullscreen]="true" (closeFullscreen)="closeWindow()" />
            } @else if (bilingualAudioData(); as audio) {
              @if (bilingualPairKeys().length > 1) {
                <div class="pair-picker">
                  @for (key of bilingualPairKeys(); track key) {
                    <button
                      class="pair-btn"
                      [class.active]="(audio.sourceLang + '-' + audio.targetLang) === key"
                      (click)="selectedBilingualKey.set(key)"
                    >{{ key.toUpperCase() }}</button>
                  }
                </div>
              }
              <app-bilingual-player [audiobook]="audio" />
            } @else {
              <div class="state">
                <p>No audiobook yet. Use Stream to preview, or run the Process pipeline first.</p>
              </div>
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
    .mode-bar {
      display: flex; gap: 6px; padding: 8px 16px; flex-shrink: 0;
    }
    .mode-btn {
      padding: 6px 16px; border: none; border-radius: 14px;
      background: var(--bg-elevated); color: var(--text-secondary);
      font-size: 13px; cursor: pointer; transition: all 0.15s;
    }
    .mode-btn:hover:not(.disabled) { color: var(--text-primary); }
    .mode-btn.active { background: var(--accent-primary, #06b6d4); color: white; }
    .mode-btn.disabled { opacity: 0.4; cursor: not-allowed; }
    .player-area { flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .player-area > * { flex: 1; min-height: 0; }
    .pair-picker {
      display: flex; gap: 8px; padding: 4px 16px 8px; flex: 0 0 auto;
    }
    .pair-btn {
      padding: 4px 12px; border: 1px solid var(--border-default);
      border-radius: 12px; background: var(--bg-elevated);
      color: var(--text-secondary); font-size: 11px; cursor: pointer;
    }
    .pair-btn.active { background: var(--accent-primary, #06b6d4); border-color: transparent; color: white; }
    .state {
      flex: 1; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 12px;
      color: var(--text-secondary);
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

  readonly loading = signal(true);
  readonly projectPath = signal('');
  readonly mode = signal<'play' | 'stream'>('play');
  readonly item = signal<StudioItem | null>(null);
  readonly selectedBilingualKey = signal('');

  private unsubscribeSetMode?: () => void;

  readonly hasAudio = computed(() => {
    const it = this.item();
    if (!it) return false;
    return (!!it.audiobookPath && !!it.vttPath) ||
      (!!it.bilingualOutputs && Object.keys(it.bilingualOutputs).length > 0);
  });

  readonly epubPath = computed(() => {
    const it = this.item();
    if (!it) return '';
    return it.cleanedEpubPath || it.epubPath || '';
  });

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

  readonly bilingualPairKeys = computed(() => {
    const it = this.item();
    if (!it?.bilingualOutputs) return [];
    return Object.keys(it.bilingualOutputs);
  });

  readonly bilingualAudioData = computed(() => {
    const it = this.item();
    if (!it?.bilingualOutputs) return null;
    const keys = Object.keys(it.bilingualOutputs);
    if (keys.length === 0) return null;
    let key = this.selectedBilingualKey();
    if (!key || !it.bilingualOutputs[key]) key = keys[0];
    const output = it.bilingualOutputs[key];
    if (!output.audioPath || !output.vttPath) return null;
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
    const params = this.route.snapshot.queryParamMap;
    const project = params.get('project') || '';
    const mode = params.get('mode');
    this.projectPath.set(project);
    if (mode === 'stream' || mode === 'play') this.mode.set(mode);

    // Main process re-routes an already-open window when asked for a different mode
    this.unsubscribeSetMode = this.electronService.onSetListenMode(m => this.mode.set(m));

    try {
      await this.libraryService.whenReady();
      await this.studioService.loadAll();
      const all = [...this.studioService.books(), ...this.studioService.articles()];
      const item = all.find(i => i.id === project || i.bfpPath === project) ?? null;
      this.item.set(item);

      if (item) {
        document.title = `Listen — ${item.title}`;
        // No audio yet → Play is impossible, fall back to Stream
        if (this.mode() === 'play' && !this.hasAudio()) {
          this.mode.set('stream');
        }
      }
    } finally {
      this.loading.set(false);
    }
  }

  ngOnDestroy(): void {
    this.unsubscribeSetMode?.();
  }

  closeWindow(): void {
    window.close();
  }
}
