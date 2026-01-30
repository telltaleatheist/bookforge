import { Component, Input, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TTSJobAnalytics, CleanupJobAnalytics, ProjectAnalytics } from '../../../../core/models/analytics.types';

@Component({
  selector: 'app-analytics-panel',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="analytics-panel">
      @if (!hasAnyAnalytics()) {
        <div class="empty-state">
          <div class="empty-icon">📊</div>
          <p>No analytics data available yet.</p>
          <p class="hint">Analytics will appear here after running AI cleanup or TTS conversion jobs.</p>
        </div>
      } @else {
        <!-- Job Type Selector -->
        <div class="job-type-tabs">
          <button
            class="tab"
            [class.active]="selectedJobType() === 'tts'"
            (click)="selectedJobType.set('tts')"
            [disabled]="!hasTtsJobs()"
          >
            TTS Jobs ({{ ttsJobs().length }})
          </button>
          <button
            class="tab"
            [class.active]="selectedJobType() === 'cleanup'"
            (click)="selectedJobType.set('cleanup')"
            [disabled]="!hasCleanupJobs()"
          >
            Cleanup Jobs ({{ cleanupJobs().length }})
          </button>
        </div>

        <!-- Job Selector Dropdown -->
        @if (currentJobs().length > 1) {
          <div class="job-selector">
            <label>Select Job:</label>
            <select (change)="onJobSelect($event)">
              @for (job of currentJobs(); track job.jobId; let i = $index) {
                <option [value]="i" [selected]="i === selectedJobIndex()">
                  {{ formatJobDate(job.startedAt) }} - {{ job.success ? 'Success' : 'Failed' }}
                </option>
              }
            </select>
          </div>
        }

        <!-- Analytics Display -->
        @if (selectedJob()) {
          <div class="analytics-content">
            @if (selectedJobType() === 'tts') {
              <ng-container *ngTemplateOutlet="ttsAnalytics; context: { job: selectedJob() }"></ng-container>
            } @else {
              <ng-container *ngTemplateOutlet="cleanupAnalytics; context: { job: selectedJob() }"></ng-container>
            }
          </div>
        }
      }
    </div>

    <!-- TTS Analytics Template -->
    <ng-template #ttsAnalytics let-job="job">
      <div class="analytics-grid">
        <div class="stat-card" [class.error]="!job.success">
          <div class="stat-label">Status</div>
          <div class="stat-value">{{ job.success ? '✓ Complete' : '✗ Failed' }}</div>
        </div>

        <div class="stat-card highlight">
          <div class="stat-label">Processing Time</div>
          <div class="stat-value">{{ formatDuration(job.durationSeconds) }}</div>
        </div>

        <div class="stat-card highlight">
          <div class="stat-label">Throughput</div>
          <div class="stat-value">{{ job.sentencesPerMinute }} sent/min</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">Workers</div>
          <div class="stat-value">{{ job.workerCount }}</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">Total Sentences</div>
          <div class="stat-value">{{ job.totalSentences | number }}</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">Chapters</div>
          <div class="stat-value">{{ job.totalChapters }}</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">Device</div>
          <div class="stat-value">{{ job.settings.device.toUpperCase() }}</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">TTS Engine</div>
          <div class="stat-value">{{ job.settings.ttsEngine }}</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">Language</div>
          <div class="stat-value">{{ job.settings.language }}</div>
        </div>

        @if (job.isResumeJob) {
          <div class="stat-card">
            <div class="stat-label">Resume Job</div>
            <div class="stat-value">{{ job.sentencesProcessedInSession | number }} processed</div>
          </div>
        }
      </div>

      <div class="timestamps">
        <div><strong>Started:</strong> {{ formatTimestamp(job.startedAt) }}</div>
        <div><strong>Completed:</strong> {{ formatTimestamp(job.completedAt) }}</div>
      </div>

      @if (job.error) {
        <div class="error-message">
          <strong>Error:</strong> {{ job.error }}
        </div>
      }

      <!-- Efficiency Analysis -->
      <div class="efficiency-section">
        <h4>Efficiency Analysis</h4>
        <div class="efficiency-stats">
          <div class="efficiency-row">
            <span>Per-worker rate:</span>
            <span>{{ (job.sentencesPerMinute / job.workerCount).toFixed(1) }} sent/min/worker</span>
          </div>
          <div class="efficiency-row">
            <span>Estimated single-worker time:</span>
            <span>{{ formatDuration(job.durationSeconds * job.workerCount) }}</span>
          </div>
          <div class="efficiency-row">
            <span>Parallelization speedup:</span>
            <span>{{ job.workerCount }}x</span>
          </div>
        </div>
      </div>
    </ng-template>

    <!-- Cleanup Analytics Template -->
    <ng-template #cleanupAnalytics let-job="job">
      <div class="analytics-grid">
        <div class="stat-card" [class.error]="!job.success">
          <div class="stat-label">Status</div>
          <div class="stat-value">{{ job.success ? '✓ Complete' : '✗ Failed' }}</div>
        </div>

        <div class="stat-card highlight">
          <div class="stat-label">Processing Time</div>
          <div class="stat-value">{{ formatDuration(job.durationSeconds) }}</div>
        </div>

        <div class="stat-card highlight">
          <div class="stat-label">Throughput</div>
          <div class="stat-value">{{ job.chunksPerMinute }} chunks/min</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">Model</div>
          <div class="stat-value model-name">{{ job.model }}</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">Total Chunks</div>
          <div class="stat-value">{{ job.totalChunks | number }}</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">Chapters</div>
          <div class="stat-value">{{ job.totalChapters }}</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">Characters</div>
          <div class="stat-value">{{ job.totalCharacters | number }}</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">Char/min</div>
          <div class="stat-value">{{ job.charactersPerMinute | number }}</div>
        </div>

        @if (job.copyrightChunksAffected > 0) {
          <div class="stat-card warning">
            <div class="stat-label">Copyright Skips</div>
            <div class="stat-value">{{ job.copyrightChunksAffected }}</div>
          </div>
        }

        @if (job.contentSkipsAffected > 0) {
          <div class="stat-card warning">
            <div class="stat-label">Content Skips</div>
            <div class="stat-value">{{ job.contentSkipsAffected }}</div>
          </div>
        }
      </div>

      <div class="timestamps">
        <div><strong>Started:</strong> {{ formatTimestamp(job.startedAt) }}</div>
        <div><strong>Completed:</strong> {{ formatTimestamp(job.completedAt) }}</div>
      </div>

      @if (job.error) {
        <div class="error-message">
          <strong>Error:</strong> {{ job.error }}
        </div>
      }
    </ng-template>
  `,
  styles: [`
    .analytics-panel {
      padding: 16px;
      height: 100%;
      overflow-y: auto;
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 48px 24px;
      text-align: center;
      color: var(--text-secondary);
    }

    .empty-icon {
      font-size: 48px;
      margin-bottom: 16px;
      opacity: 0.5;
    }

    .empty-state p {
      margin: 4px 0;
    }

    .empty-state .hint {
      font-size: 12px;
      opacity: 0.7;
    }

    .job-type-tabs {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
    }

    .job-type-tabs .tab {
      flex: 1;
      padding: 8px 16px;
      border: 1px solid var(--border-color);
      background: var(--bg-secondary);
      color: var(--text-primary);
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .job-type-tabs .tab:hover:not(:disabled) {
      background: var(--bg-tertiary);
    }

    .job-type-tabs .tab.active {
      background: var(--accent-color);
      color: white;
      border-color: var(--accent-color);
    }

    .job-type-tabs .tab:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .job-selector {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 16px;
    }

    .job-selector label {
      font-size: 13px;
      color: var(--text-secondary);
    }

    .job-selector select {
      flex: 1;
      padding: 6px 8px;
      border: 1px solid var(--border-color);
      background: var(--bg-secondary);
      color: var(--text-primary);
      border-radius: 4px;
      font-size: 13px;
      cursor: pointer;
    }

    .job-selector select option {
      background: var(--bg-secondary);
      color: var(--text-primary);
    }

    .analytics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
      gap: 12px;
      margin-bottom: 16px;
    }

    .stat-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 12px;
      text-align: center;
    }

    .stat-card.highlight {
      background: var(--accent-color-subtle, rgba(59, 130, 246, 0.1));
      border-color: var(--accent-color);
    }

    .stat-card.warning {
      background: rgba(245, 158, 11, 0.1);
      border-color: #f59e0b;
    }

    .stat-card.error {
      background: rgba(239, 68, 68, 0.1);
      border-color: #ef4444;
    }

    .stat-label {
      font-size: 11px;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
    }

    .stat-value {
      font-size: 18px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .stat-value.model-name {
      font-size: 12px;
      word-break: break-all;
    }

    .timestamps {
      background: var(--bg-secondary);
      border-radius: 4px;
      padding: 12px;
      font-size: 12px;
      color: var(--text-secondary);
      margin-bottom: 16px;
    }

    .timestamps div {
      margin: 4px 0;
    }

    .error-message {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid #ef4444;
      border-radius: 4px;
      padding: 12px;
      color: #ef4444;
      font-size: 13px;
      margin-bottom: 16px;
    }

    .efficiency-section {
      background: var(--bg-secondary);
      border-radius: 8px;
      padding: 16px;
    }

    .efficiency-section h4 {
      margin: 0 0 12px 0;
      font-size: 14px;
      color: var(--text-primary);
    }

    .efficiency-stats {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .efficiency-row {
      display: flex;
      justify-content: space-between;
      font-size: 13px;
    }

    .efficiency-row span:first-child {
      color: var(--text-secondary);
    }

    .efficiency-row span:last-child {
      color: var(--text-primary);
      font-weight: 500;
    }
  `]
})
export class AnalyticsPanelComponent {
  @Input() set analytics(value: ProjectAnalytics | undefined) {
    if (value) {
      this._ttsJobs.set(value.ttsJobs || []);
      this._cleanupJobs.set(value.cleanupJobs || []);

      // Auto-select job type based on what's available
      if (value.ttsJobs?.length && !value.cleanupJobs?.length) {
        this.selectedJobType.set('tts');
      } else if (value.cleanupJobs?.length && !value.ttsJobs?.length) {
        this.selectedJobType.set('cleanup');
      }

      // Reset job index when analytics change
      this.selectedJobIndex.set(0);
    } else {
      this._ttsJobs.set([]);
      this._cleanupJobs.set([]);
    }
  }

  private readonly _ttsJobs = signal<TTSJobAnalytics[]>([]);
  private readonly _cleanupJobs = signal<CleanupJobAnalytics[]>([]);

  readonly selectedJobType = signal<'tts' | 'cleanup'>('tts');
  readonly selectedJobIndex = signal(0);

  readonly ttsJobs = computed(() => this._ttsJobs());
  readonly cleanupJobs = computed(() => this._cleanupJobs());

  readonly hasTtsJobs = computed(() => this._ttsJobs().length > 0);
  readonly hasCleanupJobs = computed(() => this._cleanupJobs().length > 0);
  readonly hasAnyAnalytics = computed(() => this.hasTtsJobs() || this.hasCleanupJobs());

  readonly currentJobs = computed(() => {
    return this.selectedJobType() === 'tts'
      ? this._ttsJobs()
      : this._cleanupJobs();
  });

  readonly selectedJob = computed(() => {
    const jobs = this.currentJobs();
    const index = this.selectedJobIndex();
    return jobs[index] || null;
  });

  onJobSelect(event: Event): void {
    const select = event.target as HTMLSelectElement;
    this.selectedJobIndex.set(parseInt(select.value, 10));
  }

  formatDuration(seconds: number): string {
    if (seconds < 60) {
      return `${seconds}s`;
    }
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`;
    }
    return `${minutes}m ${secs}s`;
  }

  formatTimestamp(isoString: string): string {
    return new Date(isoString).toLocaleString();
  }

  formatJobDate(isoString: string): string {
    const date = new Date(isoString);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
}
