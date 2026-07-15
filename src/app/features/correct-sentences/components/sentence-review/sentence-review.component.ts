import {
  ChangeDetectionStrategy, Component, ElementRef, OnDestroy, computed, effect, inject, input, output, signal, viewChild,
} from '@angular/core';
import { ElectronService } from '../../../../core/services/electron.service';
import { CandidateSet, CorrectSentencesSession, ReviewRow } from '../../models/correct-sentences.types';

/**
 * Phase 2 — for each flagged sentence, audition the Original plus 3 fresh takes (each
 * played in context: previous sentence → candidate → next sentence). Approve one to
 * commit it into the cache, or Re-roll for 3 new takes. Done: approved/kept rows drop
 * off; re-rolled rows regenerate and stay; loop until the list is empty → Assemble.
 */
@Component({
  selector: 'app-sentence-review',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [],
  template: `
    <div class="rv">
      <header class="rv-top">
        <button class="rv-link" (click)="back.emit()">← Back</button>
        <div class="rv-title">Review &amp; regenerate</div>
        <span class="rv-count">{{ visibleRows().length }} to review</span>
      </header>

      @if (generating()) {
        <div class="rv-center">
          <div class="rv-spinner"></div>
          <span>Generating takes… {{ progress().done }} / {{ progress().total }}</span>
          <button class="rv-ghost" (click)="cancel()">Cancel</button>
        </div>
      } @else if (error()) {
        <div class="rv-center rv-error">
          <p>{{ error() }}</p>
          <button class="rv-ghost" (click)="back.emit()">Back</button>
        </div>
      } @else {
        <div class="rv-list">
          @for (row of visibleRows(); track row.index) {
            <div class="row">
              <div class="row-head">
                <span class="row-idx">#{{ row.index + 1 }}</span>
                @if (row.failed) { <span class="row-fail">generation failed — keep original</span> }
              </div>
              <p class="row-text">{{ row.text }}</p>
              <div class="opts">
                @for (opt of row.options; track $index) {
                  <button class="opt" [class.sel]="row.selected === $index" (click)="select(row, $index)">
                    <span class="opt-label">{{ opt.label }}</span>
                    <button class="opt-play" (click)="playToggle(row, $index, $event)"
                            [class.playing]="isThisPlaying(row.index, $index)"
                            [title]="isThisPlaying(row.index, $index) ? 'Pause' : 'Play this take'">{{ isThisPlaying(row.index, $index) ? '⏸' : '▶' }}</button>
                  </button>
                }
              </div>
              <div class="row-actions">
                <button class="ra reroll" [class.on]="row.reroll" (click)="toggleReroll(row)">↻ Re-roll</button>
                <button class="ra approve" (click)="approve(row)">✓ Approve</button>
              </div>
            </div>
          } @empty {
            <div class="rv-center"><p>All sentences resolved.</p></div>
          }
        </div>

        <div class="rv-foot">
          <span class="rv-foot-hint">Approve keeps your pick. Re-roll gets 3 new takes on Done.</span>
          <button class="rv-done" (click)="onDone()">Done</button>
        </div>
      }

      <audio #audio (ended)="onAudioEnded()" (play)="isPlaying.set(true)" (pause)="isPlaying.set(false)"></audio>
    </div>
  `,
  styles: [`
    :host { display: flex; flex: 1; min-height: 0; }
    .rv { display: flex; flex-direction: column; flex: 1; min-height: 0; width: 100%; }
    .rv-top { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-bottom: 1px solid var(--border-default); }
    .rv-link { border: none; background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 13px; }
    .rv-title { flex: 1; text-align: center; font-weight: 600; color: var(--text-primary); }
    .rv-count { font-size: 12px; color: var(--text-tertiary, var(--text-secondary)); }

    .rv-center { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: var(--text-secondary); }
    .rv-error { color: var(--error, #ff453a); text-align: center; padding: 20px; }
    .rv-spinner { width: 30px; height: 30px; border-radius: 50%; border: 3px solid var(--border-default); border-top-color: var(--accent-primary); animation: rv-spin 0.8s linear infinite; }
    @keyframes rv-spin { to { transform: rotate(360deg); } }
    .rv-ghost { padding: 7px 14px; border: 1px solid var(--border-default); border-radius: 8px; background: transparent; color: var(--text-secondary); cursor: pointer; }

    .rv-list { flex: 1; overflow-y: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 12px; }
    .row { border: 1px solid var(--border-default); border-radius: 10px; padding: 12px; background: var(--bg-surface); }
    .row-head { display: flex; align-items: center; gap: 8px; }
    .row-idx { font-size: 12px; font-weight: 700; color: var(--accent-primary); }
    .row-fail { font-size: 11px; color: var(--error, #ff453a); }
    .row-text { margin: 6px 0 10px; font-size: 14px; line-height: 1.5; color: var(--text-primary); }
    .opts { display: flex; flex-wrap: wrap; gap: 8px; }
    .opt { display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 12px; border: 1.5px solid var(--border-default); border-radius: 20px; background: var(--bg-elevated); color: var(--text-primary); cursor: pointer; font-size: 13px; }
    .opt.sel { border-color: var(--accent-primary); background: color-mix(in srgb, var(--accent-primary) 14%, var(--bg-elevated)); }
    .opt-label { font-weight: 600; }
    .opt-play { width: 24px; height: 24px; border: none; border-radius: 50%; background: var(--bg-hover, var(--bg-surface)); color: var(--text-secondary); cursor: pointer; font-size: 10px; }
    .opt-play.playing { background: var(--accent-primary); color: #fff; }
    .row-actions { display: flex; gap: 8px; margin-top: 12px; }
    .ra { padding: 7px 14px; border-radius: 8px; border: 1px solid var(--border-default); background: transparent; cursor: pointer; font-size: 13px; font-weight: 600; }
    .ra.reroll { color: var(--text-secondary); }
    .ra.reroll.on { border-color: var(--accent-primary); color: var(--accent-primary); background: color-mix(in srgb, var(--accent-primary) 10%, transparent); }
    .ra.approve { border-color: var(--accent-primary); background: var(--accent-primary); color: #fff; margin-left: auto; }

    .rv-foot { flex-shrink: 0; display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-top: 1px solid var(--border-default); }
    .rv-foot-hint { flex: 1; font-size: 12px; color: var(--text-tertiary, var(--text-secondary)); }
    .rv-done { padding: 9px 22px; border: none; border-radius: 8px; background: var(--accent-primary); color: #fff; font-weight: 600; cursor: pointer; }
    audio { display: none; }
  `],
})
export class SentenceReviewComponent implements OnDestroy {
  private readonly electron = inject(ElectronService);
  private readonly audioRef = viewChild<ElementRef<HTMLAudioElement>>('audio');

  readonly session = input.required<CorrectSentencesSession>();
  readonly projectDir = input.required<string>();
  readonly flagged = input.required<number[]>();
  readonly done = output<void>();
  readonly back = output<void>();

  readonly rows = signal<ReviewRow[]>([]);
  readonly generating = signal(false);
  readonly progress = signal<{ done: number; total: number }>({ done: 0, total: 0 });
  readonly error = signal<string | null>(null);
  readonly playingKey = signal<string | null>(null);
  readonly isPlaying = signal(false);

  readonly visibleRows = computed(() => this.rows().filter((r) => !r.resolved));

  private currentJobId: string | null = null;
  private readonly unsubProgress: () => void;
  private started = false;

  constructor() {
    this.unsubProgress = this.electron.onCorrectSentencesProgress((d) => {
      if (d.jobId === this.currentJobId) this.progress.set({ done: d.done, total: d.total });
    });
    effect(() => {
      const idx = this.flagged();
      if (idx?.length && !this.started) {
        this.started = true;
        void this.generateFor(idx, true);
      }
    });
  }

  ngOnDestroy(): void { this.unsubProgress?.(); }

  private cueText(index: number): string {
    return this.session().cues?.find((c) => c.index === index)?.text ?? '';
  }

  private buildRow(c: CandidateSet): ReviewRow {
    const options = [
      { label: 'Original', path: c.originalPath, isOriginal: true },
      ...c.takePaths.map((p, i) => ({ label: `Take ${i + 1}`, path: p, isOriginal: false })),
    ];
    return {
      index: c.index, text: this.cueText(c.index), originalPath: c.originalPath,
      options, selected: 0, reroll: false, resolved: false, failed: c.failed,
    } as ReviewRow & { failed?: boolean };
  }

  private async generateFor(indices: number[], replaceAll: boolean): Promise<void> {
    this.generating.set(true);
    this.error.set(null);
    this.progress.set({ done: 0, total: indices.length * 3 });
    const jobId = `correct-${indices.length}-${indices.join('_')}`;
    this.currentJobId = jobId;
    const res = await this.electron.correctSentencesGenerateCandidates(jobId, {
      projectDir: this.projectDir(), indices, takes: 3,
    });
    this.generating.set(false);
    this.currentJobId = null;
    if (!res?.success || !res.data) {
      this.error.set(res?.error || 'Generation failed.');
      return;
    }
    const fresh = (res.data.candidates as CandidateSet[]).map((c) => this.buildRow(c));
    if (replaceAll) {
      this.rows.set(fresh);
    } else {
      const map = new Map(fresh.map((r) => [r.index, r]));
      this.rows.set(this.rows().map((r) => map.get(r.index) ?? r));
    }
  }

  private updateRow(index: number, fn: (r: ReviewRow) => ReviewRow): void {
    this.rows.set(this.rows().map((r) => (r.index === index ? fn(r) : r)));
  }

  select(row: ReviewRow, optIdx: number): void {
    this.updateRow(row.index, (r) => ({ ...r, selected: optIdx }));
  }

  toggleReroll(row: ReviewRow): void {
    this.updateRow(row.index, (r) => ({ ...r, reroll: !r.reroll }));
  }

  async approve(row: ReviewRow): Promise<void> {
    const opt = row.options[row.selected];
    const res = await this.electron.correctSentencesCommit({
      projectDir: this.projectDir(), index: row.index, sourceFlacPath: opt.path,
    });
    if (!res?.success) { this.error.set(res?.error || 'Commit failed.'); return; }
    this.updateRow(row.index, (r) => ({ ...r, resolved: true }));
    if (this.visibleRows().length === 0) this.done.emit();
  }

  async onDone(): Promise<void> {
    const keep = this.visibleRows().filter((r) => !r.reroll);
    for (const r of keep) {
      const opt = r.options[r.selected];
      if (!opt.isOriginal) {
        const res = await this.electron.correctSentencesCommit({
          projectDir: this.projectDir(), index: r.index, sourceFlacPath: opt.path,
        });
        if (!res?.success) { this.error.set(res?.error || 'Commit failed.'); return; }
      }
      this.updateRow(r.index, (x) => ({ ...x, resolved: true }));
    }
    const rerollIdx = this.visibleRows().filter((r) => r.reroll).map((r) => r.index);
    if (rerollIdx.length) {
      await this.generateFor(rerollIdx, false);
      this.rows.set(this.rows().map((r) => (rerollIdx.includes(r.index) ? { ...r, reroll: false, selected: 0 } : r)));
    } else {
      this.done.emit();
    }
  }

  cancel(): void {
    if (this.currentJobId) void this.electron.correctSentencesCancel(this.currentJobId);
  }

  // ── Single-take audition with play/pause toggle (only the one take, no context) ──
  isThisPlaying(rowIndex: number, optIdx: number): boolean {
    return this.playingKey() === `${rowIndex}:${optIdx}` && this.isPlaying();
  }

  playToggle(row: ReviewRow, optIdx: number, ev: Event): void {
    ev.stopPropagation();
    const audio = this.audioRef()?.nativeElement;
    if (!audio) return;
    const key = `${row.index}:${optIdx}`;
    if (this.playingKey() === key) {
      // Same take: toggle pause / resume.
      if (audio.paused) audio.play().catch(() => {}); else audio.pause();
      return;
    }
    void this.startPlay(row.options[optIdx].path, key);
  }

  private async startPlay(pathToPlay: string, key: string): Promise<void> {
    const audio = this.audioRef()?.nativeElement;
    if (!audio) return;
    const res = await this.electron.readAudioFile(pathToPlay);
    if (!res?.success || !res.dataUrl) return;
    this.playingKey.set(key);
    audio.src = res.dataUrl;
    audio.play().catch(() => {});
  }

  onAudioEnded(): void {
    this.isPlaying.set(false);
    this.playingKey.set(null);
  }
}
