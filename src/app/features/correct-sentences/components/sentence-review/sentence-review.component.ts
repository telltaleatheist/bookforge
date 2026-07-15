import {
  ChangeDetectionStrategy, Component, ElementRef, OnDestroy, computed, effect, inject, input, output, signal, viewChild,
} from '@angular/core';
import { ElectronService } from '../../../../core/services/electron.service';
import { CandidateSet, CorrectSentencesSession, ReviewRow } from '../../models/correct-sentences.types';

/**
 * Phase 2 — the flagged sentences land here WITHOUT generating anything yet. Each row shows
 * the sentence in an editable box (with only the Original playable) so the user can fix the
 * text first — add punctuation, split a crammed run-on, etc. Editing auto-checks re-roll.
 * A ✕ cancels a mis-flag (leaves the original untouched). Hitting Done (bottom-right)
 * generates 3 varied takes for the re-roll-checked rows (one take for long multi-chunk
 * edits); after that the user auditions, Approves a take, or re-rolls again. Loop until the
 * list is empty → Assemble.
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
        <span class="rv-count">{{ visibleRows().length }}</span>
      </header>

      @if (error()) {
        <div class="rv-banner">
          <span>{{ error() }}</span>
          <button class="rv-ghost" (click)="error.set(null)">Dismiss</button>
        </div>
      }

      <div class="rv-list">
        @for (row of visibleRows(); track row.index) {
          <div class="row">
            <div class="row-head">
              <span class="row-idx">#{{ row.index + 1 }}</span>
              @if (row.edited) { <span class="row-badge">edited</span> }
              @if (row.failed) { <span class="row-fail">generation failed — keep original</span> }
              <button class="row-x" (click)="removeRow(row)" title="Remove — keep the original, cancel this flag">✕</button>
            </div>

            <textarea class="row-text" rows="2" [value]="row.text"
                      (change)="onEdit(row, $event)"
                      placeholder="Sentence text…"></textarea>

            <div class="opts">
              @for (opt of row.options; track $index) {
                <button class="opt" [class.sel]="row.selected === $index" (click)="select(row, $index)">
                  <span class="opt-label">{{ opt.label }}</span>
                  <button class="opt-play" (click)="playToggle(row, $index, $event)"
                          [class.playing]="isThisPlaying(row.index, $index)"
                          [title]="isThisPlaying(row.index, $index) ? 'Pause' : 'Play'">{{ isThisPlaying(row.index, $index) ? '⏸' : '▶' }}</button>
                </button>
              }
            </div>

            <div class="row-actions">
              <label class="reroll-check" [class.on]="row.reroll">
                <input type="checkbox" [checked]="row.reroll" (change)="toggleReroll(row)" />
                <span>↻ Re-roll{{ hasTakes(row) ? ' again' : '' }}</span>
              </label>
              @if (hasTakes(row)) {
                <button class="ra approve" (click)="approve(row)">✓ Approve</button>
              }
            </div>
          </div>
        } @empty {
          <div class="rv-center"><p>Nothing to correct.</p></div>
        }
      </div>

      <div class="rv-foot">
        <span class="rv-foot-hint">
          @if (generating()) { Generating… {{ progress().done }} / {{ progress().total }} }
          @else { Edit the text, pick a take, or ✕ to keep the original. }
        </span>
        @if (generating()) {
          <button class="rv-ghost" (click)="cancel()">Cancel</button>
        } @else {
          <button class="rv-done" [disabled]="visibleRows().length === 0" (click)="onDone()">Done</button>
        }
      </div>

      <audio #audio (ended)="onAudioEnded()" (play)="isPlaying.set(true)" (pause)="isPlaying.set(false)"></audio>
    </div>
  `,
  styles: [`
    :host { display: flex; flex: 1; min-height: 0; }
    .rv { display: flex; flex-direction: column; flex: 1; min-height: 0; width: 100%; }
    .rv-top { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-bottom: 1px solid var(--border-default); }
    .rv-link { border: none; background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 13px; }
    .rv-title { flex: 1; text-align: center; font-weight: 600; color: var(--text-primary); }
    .rv-count { min-width: 22px; text-align: center; font-size: 12px; font-weight: 700; color: var(--accent-primary); }

    .rv-banner { display: flex; align-items: center; gap: 12px; padding: 8px 14px; background: color-mix(in srgb, var(--error, #ff453a) 12%, transparent); color: var(--error, #ff453a); font-size: 13px; }
    .rv-banner span { flex: 1; }
    .rv-center { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: var(--text-secondary); }
    .rv-ghost { padding: 7px 14px; border: 1px solid var(--border-default); border-radius: 8px; background: transparent; color: var(--text-secondary); cursor: pointer; }

    .rv-list { flex: 1; overflow-y: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 12px; }
    .row { border: 1px solid var(--border-default); border-radius: 10px; padding: 12px; background: var(--bg-surface); }
    .row-head { display: flex; align-items: center; gap: 8px; }
    .row-idx { font-size: 12px; font-weight: 700; color: var(--accent-primary); }
    .row-badge { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; padding: 2px 6px; border-radius: 4px; background: color-mix(in srgb, var(--accent-primary) 16%, transparent); color: var(--accent-primary); }
    .row-fail { font-size: 11px; color: var(--error, #ff453a); }
    .row-x { margin-left: auto; width: 24px; height: 24px; border: none; border-radius: 6px; background: transparent; color: var(--text-tertiary, var(--text-secondary)); cursor: pointer; font-size: 13px; }
    .row-x:hover { background: color-mix(in srgb, var(--error, #ff453a) 14%, transparent); color: var(--error, #ff453a); }

    .row-text { width: 100%; box-sizing: border-box; margin: 8px 0 10px; padding: 8px 10px; font: inherit; font-size: 14px; line-height: 1.5; color: var(--text-primary); background: var(--bg-elevated); border: 1px solid var(--border-default); border-radius: 8px; resize: vertical; min-height: 48px; }
    .row-text:focus { outline: none; border-color: var(--accent-primary); }

    .opts { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .opt { display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 12px; border: 1.5px solid var(--border-default); border-radius: 20px; background: var(--bg-elevated); color: var(--text-primary); cursor: pointer; font-size: 13px; }
    .opt.sel { border-color: var(--accent-primary); background: color-mix(in srgb, var(--accent-primary) 14%, var(--bg-elevated)); }
    .opt-label { font-weight: 600; }
    .opt-play { width: 24px; height: 24px; border: none; border-radius: 50%; background: var(--bg-hover, var(--bg-surface)); color: var(--text-secondary); cursor: pointer; font-size: 10px; }
    .opt-play.playing { background: var(--accent-primary); color: #fff; }

    .row-actions { display: flex; gap: 8px; align-items: center; margin-top: 12px; }
    .reroll-check { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; color: var(--text-secondary); cursor: pointer; user-select: none; }
    .reroll-check.on { color: var(--accent-primary); }
    .reroll-check input { accent-color: var(--accent-primary); cursor: pointer; }
    .ra { padding: 7px 14px; border-radius: 8px; border: 1px solid var(--border-default); background: transparent; cursor: pointer; font-size: 13px; font-weight: 600; }
    .ra.approve { border-color: var(--accent-primary); background: var(--accent-primary); color: #fff; margin-left: auto; }

    .rv-foot { flex-shrink: 0; display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-top: 1px solid var(--border-default); }
    .rv-foot-hint { flex: 1; font-size: 12px; color: var(--text-tertiary, var(--text-secondary)); }
    .rv-done { padding: 9px 22px; border: none; border-radius: 8px; background: var(--accent-primary); color: #fff; font-weight: 600; cursor: pointer; }
    .rv-done:disabled { opacity: 0.4; cursor: default; }
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
    // Build the editable rows WITHOUT generating — the user edits/prunes first, then Done
    // triggers the first generation. Re-roll defaults on (they flagged these to be fixed).
    effect(() => {
      const idx = this.flagged();
      if (idx?.length && !this.started) {
        this.started = true;
        const dir = this.session().sentencesDir ?? '';
        this.rows.set(idx.map((i) => ({
          index: i,
          text: this.cueText(i),
          originalPath: `${dir}/${i}.flac`,
          options: [{ label: 'Original', path: `${dir}/${i}.flac`, isOriginal: true }],
          selected: 0,
          reroll: true,
          resolved: false,
          edited: false,
        } as ReviewRow)));
      }
    });
  }

  ngOnDestroy(): void { this.unsubProgress?.(); }

  hasTakes(row: ReviewRow): boolean { return row.options.length > 1; }

  private cueText(index: number): string {
    return this.session().cues?.find((c) => c.index === index)?.text ?? '';
  }

  private updateRow(index: number, fn: (r: ReviewRow) => ReviewRow): void {
    this.rows.set(this.rows().map((r) => (r.index === index ? fn(r) : r)));
  }

  onEdit(row: ReviewRow, ev: Event): void {
    const text = (ev.target as HTMLTextAreaElement).value;
    const changed = text.trim() !== this.cueText(row.index).trim();
    // Editing implies wanting a fresh render of the new text → auto-check re-roll.
    this.updateRow(row.index, (r) => ({ ...r, text, edited: changed, reroll: changed ? true : r.reroll }));
  }

  removeRow(row: ReviewRow): void {
    if (this.playingKey()?.startsWith(`${row.index}:`)) { this.audioRef()?.nativeElement.pause(); this.playingKey.set(null); }
    this.rows.set(this.rows().filter((r) => r.index !== row.index));
  }

  select(row: ReviewRow, optIdx: number): void {
    this.updateRow(row.index, (r) => ({ ...r, selected: optIdx }));
  }

  toggleReroll(row: ReviewRow): void {
    this.updateRow(row.index, (r) => ({ ...r, reroll: !r.reroll }));
  }

  async approve(row: ReviewRow): Promise<void> {
    const opt = row.options[row.selected];
    if (opt && !opt.isOriginal) {
      const res = await this.electron.correctSentencesCommit({
        projectDir: this.projectDir(), index: row.index, sourceFlacPath: opt.path,
      });
      if (!res?.success) { this.error.set(res?.error || 'Commit failed.'); return; }
    }
    this.updateRow(row.index, (r) => ({ ...r, resolved: true }));
    if (this.visibleRows().length === 0) this.done.emit();
  }

  async onDone(): Promise<void> {
    // Rows NOT set to re-roll → the user has decided: commit their pick (Original = keep).
    const decided = this.visibleRows().filter((r) => !r.reroll);
    for (const r of decided) {
      const opt = r.options[r.selected];
      if (opt && !opt.isOriginal) {
        const res = await this.electron.correctSentencesCommit({
          projectDir: this.projectDir(), index: r.index, sourceFlacPath: opt.path,
        });
        if (!res?.success) { this.error.set(res?.error || 'Commit failed.'); return; }
      }
      this.updateRow(r.index, (x) => ({ ...x, resolved: true }));
    }
    // Rows set to re-roll → generate takes (with edited-text overrides), stay on the page.
    const rerollRows = this.visibleRows().filter((r) => r.reroll);
    if (rerollRows.length) {
      const overrides: Record<number, string> = {};
      for (const r of rerollRows) if (r.edited && r.text.trim()) overrides[r.index] = r.text.trim();
      await this.generateFor(rerollRows.map((r) => r.index), overrides);
    } else if (this.visibleRows().length === 0) {
      this.done.emit();
    }
  }

  private async generateFor(indices: number[], overrides: Record<number, string>): Promise<void> {
    this.generating.set(true);
    this.error.set(null);
    this.progress.set({ done: 0, total: indices.length * 3 });
    const jobId = `correct-${indices.join('_')}-${indices.length}`;
    this.currentJobId = jobId;
    const res = await this.electron.correctSentencesGenerateCandidates(jobId, {
      projectDir: this.projectDir(), indices, takes: 3, overrides,
    });
    this.generating.set(false);
    this.currentJobId = null;
    if (!res?.success || !res.data) {
      this.error.set(res?.error || 'Generation failed.');
      return;
    }
    // Merge the fresh takes into the existing rows, preserving each row's edited text.
    const map = new Map((res.data.candidates as CandidateSet[]).map((c) => [c.index, c]));
    this.rows.set(this.rows().map((r) => {
      const c = map.get(r.index);
      if (!c) return r;
      return {
        ...r,
        options: [
          { label: 'Original', path: c.originalPath, isOriginal: true },
          ...c.takePaths.map((p, i) => ({ label: `Take ${i + 1}`, path: p, isOriginal: false })),
        ],
        selected: 0,     // default to Original so nothing commits until the user picks a take
        reroll: false,   // fresh takes are here; the user now auditions and decides
        failed: c.failed,
      };
    }));
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
