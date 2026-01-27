/**
 * Reassembly Component - Main container for browsing and reassembling incomplete e2a sessions
 */

import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { SplitPaneComponent } from '../../creamsicle-desktop';
import { SessionListComponent } from './components/session-list/session-list.component';
import { SessionDetailComponent } from './components/session-detail/session-detail.component';
import { ReassemblyService } from './services/reassembly.service';

@Component({
  selector: 'app-reassembly',
  standalone: true,
  imports: [
    CommonModule,
    SplitPaneComponent,
    SessionListComponent,
    SessionDetailComponent
  ],
  template: `
    <div class="reassembly-container">
      <!-- Header -->
      <div class="reassembly-header">
        <div class="header-content">
          <h1>Reassembly</h1>
          <p class="subtitle">Browse incomplete TTS sessions and reassemble them into audiobooks</p>
        </div>
        <div class="header-actions">
          <span class="current-path" title="{{ reassemblyService.e2aTmpPath() }}">
            Path: {{ shortenPath(reassemblyService.e2aTmpPath()) }}
          </span>
          <button class="settings-btn" (click)="goToSettings()" title="Configure e2a path in settings">
            <span class="settings-icon">&#x2699;</span>
            Settings
          </button>
        </div>
      </div>

      <!-- Main Content -->
      <div class="reassembly-content">
        <desktop-split-pane
          [primarySize]="320"
          [minSize]="240"
          [maxSize]="480"
        >
          <!-- Left Panel: Session List -->
          <div pane-primary class="left-panel">
            <app-session-list
              [sessions]="reassemblyService.sessions()"
              [selectedId]="reassemblyService.selectedSessionId()"
              (selectSession)="onSelectSession($event)"
              (refresh)="onRefresh()"
              (deleteSession)="onDeleteSession($event)"
            />
          </div>

          <!-- Right Panel: Session Detail -->
          <div pane-secondary class="right-panel">
            <app-session-detail />
          </div>
        </desktop-split-pane>
      </div>
    </div>
  `,
  styles: [`
    .reassembly-container {
      display: flex;
      flex-direction: column;
      height: 100%;
      width: 100%;
      background: var(--bg-base);
    }

    .reassembly-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 24px;
      border-bottom: 1px solid var(--border-default);
      background: var(--bg-surface);

      .header-content {
        h1 {
          margin: 0;
          font-size: 20px;
          font-weight: 600;
          color: var(--text-primary);
        }

        .subtitle {
          margin: 4px 0 0 0;
          font-size: 13px;
          color: var(--text-secondary);
        }
      }

      .header-actions {
        display: flex;
        align-items: center;
        gap: 16px;

        .current-path {
          font-size: 12px;
          color: var(--text-muted);
          max-width: 300px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .settings-btn {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 6px 12px;
          border: 1px solid var(--border-default);
          border-radius: 6px;
          background: var(--bg-base);
          color: var(--text-secondary);
          font-size: 13px;
          cursor: pointer;
          transition: all 0.15s ease;

          &:hover {
            background: var(--bg-hover);
            color: var(--text-primary);
            border-color: var(--border-hover);
          }

          .settings-icon {
            font-size: 14px;
          }
        }
      }
    }

    .reassembly-content {
      flex: 1;
      overflow: hidden;
      display: flex;
    }

    desktop-split-pane {
      width: 100%;
      height: 100%;
    }

    .left-panel,
    .right-panel {
      height: 100%;
      overflow: hidden;
    }

    .left-panel {
      border-right: 1px solid var(--border-default);
    }
  `]
})
export class ReassemblyComponent implements OnInit {
  readonly reassemblyService = inject(ReassemblyService);
  private readonly router = inject(Router);

  ngOnInit(): void {
    // Scan for sessions on mount
    this.reassemblyService.scanSessions();
  }

  onSelectSession(sessionId: string): void {
    this.reassemblyService.selectSession(sessionId);
  }

  onRefresh(): void {
    this.reassemblyService.scanSessions();
  }

  async onDeleteSession(sessionId: string): Promise<void> {
    const result = await this.reassemblyService.deleteSession(sessionId);
    if (!result.success) {
      alert(`Failed to delete session: ${result.error}`);
    }
  }

  goToSettings(): void {
    this.router.navigate(['/settings']);
  }

  shortenPath(path: string): string {
    if (!path) return '';
    // Show last 40 chars with ellipsis
    if (path.length > 45) {
      return '...' + path.slice(-42);
    }
    return path;
  }
}
