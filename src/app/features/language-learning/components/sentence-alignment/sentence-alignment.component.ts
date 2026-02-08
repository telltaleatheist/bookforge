import { Component, inject, signal, computed, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';

interface SentencePair {
  index: number;
  source: string;
  target: string;
}

interface AlignmentWindowConfig {
  pairs: SentencePair[];
  sourceLang: string;
  targetLang: string;
  blocking: boolean;
  projectId: string;
  jobId: string;
  autoClose?: boolean;
}

interface AlignmentResult {
  approved: boolean;
  pairs: SentencePair[];
  cancelled?: boolean;
}

// Language name mapping
const LANGUAGE_NAMES: Record<string, string> = {
  'en': 'English',
  'de': 'German',
  'es': 'Spanish',
  'fr': 'French',
  'it': 'Italian',
  'pt': 'Portuguese',
  'nl': 'Dutch',
  'pl': 'Polish',
  'ru': 'Russian',
  'ja': 'Japanese',
  'zh': 'Chinese',
  'ko': 'Korean',
};

@Component({
  selector: 'app-sentence-alignment',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="alignment-container" (click)="onUserInteraction()">
      <header>
        <h1>{{ blocking() ? 'Sentence Alignment Required' : 'Sentence Preview' }}</h1>
        <div class="status" [class.mismatch]="hasMismatch()">
          <span class="count">{{ sourceCount() }} source / {{ targetCount() }} target sentences</span>
          @if (hasMismatch()) {
            <span class="warning">Alignment required before continuing</span>
          } @else {
            <span class="success">Sentences aligned</span>
          }
        </div>
      </header>

      <!-- Column headers (fixed) -->
      <div class="column-headers">
        <div class="column-header source">{{ sourceLangName() }}</div>
        <div class="column-header target">{{ targetLangName() }}</div>
      </div>

      <!-- Single scrollable container with paired rows -->
      <div class="sentences-scroll">
        @for (pair of pairs(); track pair.index; let i = $index) {
          <div class="sentence-row" [class.mismatch-row]="isRowMismatched(i)">
            <!-- Source side -->
            <div class="sentence source" [class.empty]="!pair.source.trim()">
              <span class="index">{{ i + 1 }}</span>
              <span class="text">{{ pair.source || '(empty)' }}</span>
              <button
                class="btn-delete"
                (click)="deleteSource(i)"
                [disabled]="!pair.source.trim()"
                title="Delete source sentence"
              >
                Delete
              </button>
            </div>

            <!-- Target side -->
            <div class="sentence target" [class.empty]="!pair.target.trim()">
              <span class="index">{{ i + 1 }}</span>
              <span class="text">{{ pair.target || '(empty)' }}</span>
              <button
                class="btn-delete"
                (click)="deleteTarget(i)"
                [disabled]="!pair.target.trim()"
                title="Delete target sentence"
              >
                Delete
              </button>
            </div>
          </div>
        }
      </div>

      <footer>
        <div class="footer-info">
          @if (blocking()) {
            <span class="info-text">Delete extra sentences to align counts, then save to continue.</span>
          } @else {
            <span class="info-text">TTS is processing. You can review the sentences above.</span>
          }
        </div>
        <div class="footer-actions">
          <button class="btn-secondary" (click)="cancel()">Cancel Job</button>
          <button class="btn-primary" (click)="save()" [disabled]="hasMismatch()">
            Save & Continue
          </button>
        </div>
      </footer>
    </div>
  `,
  styles: [`
    :host {
      display: block;
      height: 100vh;
      overflow: hidden;
    }

    .alignment-container {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--bg-base, #1a1a1a);
      color: var(--text-primary, #e5e5e5);
    }

    header {
      padding: 16px 24px;
      background: var(--bg-surface, #242424);
      border-bottom: 1px solid var(--border-subtle, #333);

      h1 {
        margin: 0 0 8px;
        font-size: 20px;
        font-weight: 600;
        color: var(--text-primary, #e5e5e5);
      }
    }

    .status {
      display: flex;
      align-items: center;
      gap: 16px;
      font-size: 14px;

      .count {
        color: var(--text-secondary, #999);
      }

      .warning {
        padding: 4px 10px;
        border-radius: 4px;
        background: rgba(239, 68, 68, 0.15);
        color: #ef4444;
        font-weight: 500;
      }

      .success {
        padding: 4px 10px;
        border-radius: 4px;
        background: rgba(34, 197, 94, 0.15);
        color: #22c55e;
        font-weight: 500;
      }

      &.mismatch {
        .count {
          color: #ef4444;
        }
      }
    }

    /* Fixed column headers */
    .column-headers {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1px;
      background: var(--border-subtle, #333);
      flex-shrink: 0;
    }

    .column-header {
      padding: 12px 16px;
      font-size: 14px;
      font-weight: 600;
      color: var(--text-secondary, #999);
      background: var(--bg-surface, #242424);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    /* Single scroll container for synced scrolling */
    .sentences-scroll {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
    }

    /* Each row contains both source and target side-by-side */
    .sentence-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-bottom: 8px;
      border-radius: 6px;

      &.mismatch-row {
        .sentence {
          background: rgba(239, 68, 68, 0.1);
          border-left: 3px solid #ef4444;
        }
      }
    }

    .sentence {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 10px 12px;
      border-radius: 6px;
      background: var(--bg-surface, #242424);
      transition: background 0.15s;
      /* Both sides in a row expand to match the taller one */
      min-height: 50px;

      &:hover {
        background: var(--bg-hover, #2a2a2a);

        .btn-delete {
          opacity: 1;
        }
      }

      &.empty {
        opacity: 0.5;
        background: transparent;
        border: 1px dashed var(--border-default, #444);
      }
    }

    .index {
      flex-shrink: 0;
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      background: var(--bg-muted, #333);
      color: var(--text-secondary, #999);
      font-size: 12px;
      font-weight: 500;
    }

    .text {
      flex: 1;
      font-size: 14px;
      line-height: 1.5;
      color: var(--text-primary, #e5e5e5);
      word-break: break-word;
    }

    .btn-delete {
      flex-shrink: 0;
      padding: 4px 10px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--text-muted, #666);
      font-size: 12px;
      cursor: pointer;
      opacity: 0;
      transition: all 0.15s;

      &:hover:not(:disabled) {
        background: rgba(239, 68, 68, 0.15);
        color: #ef4444;
      }

      &:disabled {
        cursor: not-allowed;
      }
    }

    footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 24px;
      background: var(--bg-surface, #242424);
      border-top: 1px solid var(--border-subtle, #333);
    }

    .footer-info {
      .info-text {
        font-size: 13px;
        color: var(--text-secondary, #999);
      }
    }

    .footer-actions {
      display: flex;
      gap: 12px;
    }

    .btn-primary {
      padding: 10px 20px;
      border: none;
      border-radius: 6px;
      background: #06b6d4;
      color: white;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s;

      &:hover:not(:disabled) {
        background: #0891b2;
      }

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }

    .btn-secondary {
      padding: 10px 20px;
      border: 1px solid var(--border-default, #444);
      border-radius: 6px;
      background: transparent;
      color: var(--text-primary, #e5e5e5);
      font-size: 14px;
      cursor: pointer;

      &:hover {
        background: var(--bg-hover, #2a2a2a);
      }
    }
  `]
})
export class SentenceAlignmentComponent implements OnInit, OnDestroy {
  // State
  readonly pairs = signal<SentencePair[]>([]);
  readonly sourceLang = signal<string>('en');
  readonly targetLang = signal<string>('de');
  readonly blocking = signal<boolean>(true);
  readonly projectId = signal<string>('');
  readonly jobId = signal<string>('');

  // Computed
  readonly sourceLangName = computed(() => LANGUAGE_NAMES[this.sourceLang()] || this.sourceLang().toUpperCase());
  readonly targetLangName = computed(() => LANGUAGE_NAMES[this.targetLang()] || this.targetLang().toUpperCase());

  readonly sourceCount = computed(() => this.pairs().filter(p => p.source.trim()).length);
  readonly targetCount = computed(() => this.pairs().filter(p => p.target.trim()).length);
  readonly hasMismatch = computed(() => this.sourceCount() !== this.targetCount());

  private updateListener: (() => void) | null = null;

  async ngOnInit(): Promise<void> {
    // Load initial data from Electron
    await this.loadData();

    // Listen for data updates (if window is reused)
    if ((window as any).electron?.alignment) {
      // The main process might send updated data
      this.updateListener = () => {
        this.loadData();
      };
    }
  }

  ngOnDestroy(): void {
    // Cleanup if needed
  }

  async loadData(): Promise<void> {
    if ((window as any).electron?.alignment) {
      const data = await (window as any).electron.alignment.getData() as AlignmentWindowConfig | null;
      if (data) {
        this.pairs.set([...data.pairs]);
        this.sourceLang.set(data.sourceLang);
        this.targetLang.set(data.targetLang);
        this.blocking.set(data.blocking);
        this.projectId.set(data.projectId);
        this.jobId.set(data.jobId);
      }
    }
  }

  onUserInteraction(): void {
    // Mark that user has interacted (prevents auto-close)
    if ((window as any).electron?.alignment) {
      (window as any).electron.alignment.userInteracted();
    }
  }

  isRowMismatched(index: number): boolean {
    const pair = this.pairs()[index];
    if (!pair) return false;
    const hasSource = pair.source.trim().length > 0;
    const hasTarget = pair.target.trim().length > 0;
    // A row is mismatched if one side is empty and the other is not
    return hasSource !== hasTarget;
  }

  deleteSource(index: number): void {
    this.onUserInteraction();
    const current = this.pairs();
    if (index < 0 || index >= current.length) return;

    // Remove source text at index, shift remaining source texts up
    const newPairs = current.map((p, i) => ({ ...p }));

    // Clear the source at this index
    newPairs[index].source = '';

    // Shift remaining source texts up
    for (let i = index; i < newPairs.length - 1; i++) {
      newPairs[i].source = newPairs[i + 1].source;
    }
    newPairs[newPairs.length - 1].source = '';

    // Remove trailing empty pairs
    while (newPairs.length > 0 && !newPairs[newPairs.length - 1].source && !newPairs[newPairs.length - 1].target) {
      newPairs.pop();
    }

    // Reindex
    newPairs.forEach((p, i) => p.index = i);

    this.pairs.set(newPairs);
  }

  deleteTarget(index: number): void {
    this.onUserInteraction();
    const current = this.pairs();
    if (index < 0 || index >= current.length) return;

    // Remove target text at index, shift remaining target texts up
    const newPairs = current.map((p, i) => ({ ...p }));

    // Clear the target at this index
    newPairs[index].target = '';

    // Shift remaining target texts up
    for (let i = index; i < newPairs.length - 1; i++) {
      newPairs[i].target = newPairs[i + 1].target;
    }
    newPairs[newPairs.length - 1].target = '';

    // Remove trailing empty pairs
    while (newPairs.length > 0 && !newPairs[newPairs.length - 1].source && !newPairs[newPairs.length - 1].target) {
      newPairs.pop();
    }

    // Reindex
    newPairs.forEach((p, i) => p.index = i);

    this.pairs.set(newPairs);
  }

  async save(): Promise<void> {
    if (this.hasMismatch()) {
      return; // Can't save with mismatch
    }

    // Validation: require at least 1 pair
    const nonEmptyPairs = this.pairs().filter(p => p.source.trim() && p.target.trim());
    if (nonEmptyPairs.length === 0) {
      alert('At least one sentence pair is required.');
      return;
    }

    const result: AlignmentResult = {
      approved: true,
      pairs: nonEmptyPairs
    };

    if ((window as any).electron?.alignment) {
      await (window as any).electron.alignment.saveResult(result);
    }
  }

  async cancel(): Promise<void> {
    if ((window as any).electron?.alignment) {
      await (window as any).electron.alignment.cancel();
    }
  }
}
