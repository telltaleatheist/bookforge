import { Component, output, signal, computed, inject, ChangeDetectionStrategy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';
import { PluginService, PluginInfo } from '../../../../core/services/plugin.service';
import { ElectronService } from '../../../../core/services/electron.service';

type SettingsTab = 'general' | 'storage' | 'plugins';

interface GeneralSettings {
  disableRendering: boolean;
  previewQuality: 'low' | 'medium' | 'high';
}

@Component({
  selector: 'app-settings-modal',
  standalone: true,
  imports: [CommonModule, FormsModule, DesktopButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="modal-backdrop" (click)="close.emit()">
      <div class="settings-window" (click)="$event.stopPropagation()">
        <!-- Title bar -->
        <div class="title-bar">
          <span class="title">Settings</span>
          <button class="close-btn" (click)="close.emit()">
            <svg width="12" height="12" viewBox="0 0 12 12">
              <path d="M1 1L11 11M11 1L1 11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
          </button>
        </div>

        <!-- Tab bar (FCP-style icons) -->
        <div class="tab-bar">
          <button
            class="tab-item"
            [class.active]="activeTab() === 'general'"
            (click)="activeTab.set('general')"
          >
            <span class="tab-icon">⚙️</span>
            <span class="tab-label">General</span>
          </button>
          <button
            class="tab-item"
            [class.active]="activeTab() === 'storage'"
            (click)="activeTab.set('storage')"
          >
            <span class="tab-icon">💾</span>
            <span class="tab-label">Storage</span>
          </button>
          <button
            class="tab-item"
            [class.active]="activeTab() === 'plugins'"
            (click)="activeTab.set('plugins')"
          >
            <span class="tab-icon">🔌</span>
            <span class="tab-label">Plugins</span>
          </button>
        </div>

        <!-- Content area -->
        <div class="content-area">
          @switch (activeTab()) {
            @case ('general') {
              <div class="settings-section">
                <h2>General</h2>

                <div class="setting-row">
                  <div class="setting-info">
                    <label>Disable Page Rendering</label>
                    <p>When enabled, pages won't be pre-rendered to disk. This saves storage space but may make navigation slower.</p>
                  </div>
                  <label class="toggle">
                    <input
                      type="checkbox"
                      [checked]="settings().disableRendering"
                      (change)="updateSetting('disableRendering', $any($event.target).checked)"
                    />
                    <span class="toggle-slider"></span>
                  </label>
                </div>

                <div class="setting-row">
                  <div class="setting-info">
                    <label>Preview Quality</label>
                    <p>Quality level for page previews. Lower quality loads faster but looks less sharp.</p>
                  </div>
                  <select
                    class="select-input"
                    [value]="settings().previewQuality"
                    (change)="updateSetting('previewQuality', $any($event.target).value)"
                  >
                    <option value="low">Low (fastest)</option>
                    <option value="medium">Medium</option>
                    <option value="high">High (best quality)</option>
                  </select>
                </div>
              </div>
            }

            @case ('storage') {
              <div class="settings-section">
                <h2>Storage</h2>

                <div class="storage-card">
                  <div class="storage-header">
                    <span class="storage-icon">📁</span>
                    <div class="storage-info">
                      <h3>Page Render Cache</h3>
                      <p>Cached page images for faster loading</p>
                      <p class="storage-path">~/Documents/BookForge/cache/</p>
                    </div>
                    <div class="storage-size">
                      @if (cacheLoading()) {
                        <span class="loading">Calculating...</span>
                      } @else {
                        <span class="size">{{ formatBytes(totalCacheSize()) }}</span>
                      }
                    </div>
                  </div>
                  <div class="storage-actions">
                    <desktop-button
                      variant="ghost"
                      size="sm"
                      (click)="refreshCacheSize()"
                      [disabled]="cacheLoading()"
                    >
                      Refresh
                    </desktop-button>
                    <desktop-button
                      variant="danger"
                      size="sm"
                      (click)="clearAllCache()"
                      [disabled]="cacheLoading() || totalCacheSize() === 0"
                    >
                      Clear All
                    </desktop-button>
                  </div>
                </div>

                @if (cacheStatus()) {
                  <div class="status-banner" [class.success]="cacheStatus()!.success" [class.error]="!cacheStatus()!.success">
                    {{ cacheStatus()!.message }}
                  </div>
                }
              </div>
            }

            @case ('plugins') {
              <div class="settings-section">
                <h2>Plugins</h2>

                @if (pluginService.loading()) {
                  <div class="loading-state">Loading plugins...</div>
                } @else if (plugins().length === 0) {
                  <div class="empty-state">
                    <span class="empty-icon">🔌</span>
                    <p>No plugins installed</p>
                  </div>
                } @else {
                  <div class="plugins-list">
                    @for (plugin of plugins(); track plugin.id) {
                      <div class="plugin-card" [class.unavailable]="!plugin.available">
                        <div class="plugin-header">
                          <span class="plugin-icon">{{ getPluginIcon(plugin) }}</span>
                          <div class="plugin-info">
                            <h3>{{ plugin.name }}</h3>
                            <p>{{ plugin.description }}</p>
                          </div>
                          <div class="plugin-status" [class.available]="plugin.available">
                            @if (plugin.available) {
                              <span class="status-dot"></span>
                              <span>v{{ plugin.availabilityDetails?.version || 'unknown' }}</span>
                            } @else {
                              <span class="status-dot"></span>
                              <span>Not installed</span>
                            }
                          </div>
                        </div>

                        @if (!plugin.available && plugin.availabilityDetails?.installInstructions) {
                          <div class="install-hint">
                            <span class="hint-icon">💡</span>
                            <code>{{ plugin.availabilityDetails?.installInstructions }}</code>
                          </div>
                        }

                        @if (plugin.available && plugin.settingsSchema.length > 0) {
                          <div class="plugin-settings">
                            @for (field of plugin.settingsSchema; track field.key) {
                              <div class="plugin-setting-row">
                                <label>{{ field.label }}</label>
                                @switch (field.type) {
                                  @case ('boolean') {
                                    <label class="toggle small">
                                      <input
                                        type="checkbox"
                                        [checked]="getPluginSetting(plugin.id, field.key)"
                                        (change)="setPluginSetting(plugin.id, field.key, $any($event.target).checked)"
                                      />
                                      <span class="toggle-slider"></span>
                                    </label>
                                  }
                                  @case ('string') {
                                    <input
                                      type="text"
                                      class="text-input"
                                      [value]="getPluginSetting(plugin.id, field.key) || ''"
                                      [placeholder]="field.placeholder || ''"
                                      (change)="setPluginSetting(plugin.id, field.key, $any($event.target).value)"
                                    />
                                  }
                                  @case ('path') {
                                    <input
                                      type="text"
                                      class="text-input path"
                                      [value]="getPluginSetting(plugin.id, field.key) || ''"
                                      [placeholder]="field.placeholder || 'Auto-detect'"
                                      (change)="setPluginSetting(plugin.id, field.key, $any($event.target).value)"
                                    />
                                  }
                                }
                              </div>
                            }
                          </div>
                        }
                      </div>
                    }
                  </div>
                }
              </div>
            }
          }
        </div>
      </div>
    </div>
  `,
  styles: [`
    @use '../../../../creamsicle-desktop/styles/variables' as *;

    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(4px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 9999;
      animation: fadeIn 0.15s ease-out;
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .settings-window {
      width: 680px;
      max-width: 90vw;
      max-height: 85vh;
      background: var(--bg-base);
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      animation: slideUp 0.2s ease-out;
    }

    @keyframes slideUp {
      from {
        opacity: 0;
        transform: translateY(20px) scale(0.98);
      }
      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }

    .title-bar {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 12px 16px;
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border-subtle);
      position: relative;
    }

    .title {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .close-btn {
      position: absolute;
      left: 12px;
      width: 24px;
      height: 24px;
      border: none;
      background: var(--bg-elevated);
      border-radius: 6px;
      color: var(--text-tertiary);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s;

      &:hover {
        background: var(--error);
        color: white;
      }
    }

    .tab-bar {
      display: flex;
      justify-content: center;
      gap: 4px;
      padding: 12px 16px;
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border-subtle);
    }

    .tab-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      padding: 12px 24px;
      border: none;
      background: transparent;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.15s;

      &:hover {
        background: var(--bg-hover);
      }

      &.active {
        background: var(--accent-muted);

        .tab-icon {
          transform: scale(1.1);
        }

        .tab-label {
          color: var(--accent);
          font-weight: 600;
        }
      }
    }

    .tab-icon {
      font-size: 24px;
      transition: transform 0.15s;
    }

    .tab-label {
      font-size: 11px;
      color: var(--text-secondary);
      transition: all 0.15s;
    }

    .content-area {
      flex: 1;
      overflow-y: auto;
      padding: 24px;
    }

    .settings-section {
      h2 {
        margin: 0 0 20px 0;
        font-size: 18px;
        font-weight: 600;
        color: var(--text-primary);
      }
    }

    .setting-row {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 24px;
      padding: 16px;
      background: var(--bg-surface);
      border-radius: 8px;
      margin-bottom: 12px;
    }

    .setting-info {
      flex: 1;

      label {
        display: block;
        font-size: 14px;
        font-weight: 500;
        color: var(--text-primary);
        margin-bottom: 4px;
      }

      p {
        margin: 0;
        font-size: 12px;
        color: var(--text-tertiary);
        line-height: 1.4;
      }
    }

    // Toggle switch
    .toggle {
      position: relative;
      display: inline-block;
      width: 44px;
      height: 24px;
      flex-shrink: 0;

      &.small {
        width: 36px;
        height: 20px;

        .toggle-slider::before {
          height: 14px;
          width: 14px;
          left: 2px;
          bottom: 2px;
        }

        input:checked + .toggle-slider::before {
          transform: translateX(16px);
        }
      }

      input {
        opacity: 0;
        width: 0;
        height: 0;
      }

      .toggle-slider {
        position: absolute;
        cursor: pointer;
        inset: 0;
        background: var(--bg-elevated);
        border: 1px solid var(--border-subtle);
        border-radius: 12px;
        transition: all 0.15s;

        &::before {
          position: absolute;
          content: "";
          height: 18px;
          width: 18px;
          left: 2px;
          bottom: 2px;
          background: var(--text-secondary);
          border-radius: 50%;
          transition: all 0.15s;
        }
      }

      input:checked + .toggle-slider {
        background: var(--accent);
        border-color: var(--accent);

        &::before {
          transform: translateX(20px);
          background: white;
        }
      }
    }

    .select-input {
      padding: 8px 12px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      color: var(--text-primary);
      font-size: 13px;
      cursor: pointer;

      &:focus {
        outline: none;
        border-color: var(--accent);
      }

      option {
        background: var(--bg-surface);
      }
    }

    .text-input {
      padding: 8px 12px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      color: var(--text-primary);
      font-size: 13px;
      width: 180px;

      &.path {
        width: 240px;
        font-family: monospace;
        font-size: 12px;
      }

      &:focus {
        outline: none;
        border-color: var(--accent);
      }
    }

    // Storage section
    .storage-card {
      background: var(--bg-surface);
      border-radius: 8px;
      padding: 16px;
    }

    .storage-header {
      display: flex;
      align-items: flex-start;
      gap: 12px;
    }

    .storage-icon {
      font-size: 32px;
    }

    .storage-info {
      flex: 1;

      h3 {
        margin: 0 0 4px 0;
        font-size: 14px;
        font-weight: 500;
        color: var(--text-primary);
      }

      p {
        margin: 0;
        font-size: 12px;
        color: var(--text-tertiary);
      }

      .storage-path {
        font-family: monospace;
        font-size: 11px;
        margin-top: 4px;
        opacity: 0.7;
      }
    }

    .storage-size {
      text-align: right;

      .size {
        font-size: 20px;
        font-weight: 600;
        color: var(--accent);
      }

      .loading {
        font-size: 12px;
        color: var(--text-tertiary);
      }
    }

    .storage-actions {
      display: flex;
      gap: 8px;
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--border-subtle);
    }

    .status-banner {
      margin-top: 12px;
      padding: 12px 16px;
      border-radius: 8px;
      font-size: 13px;

      &.success {
        background: rgba(34, 197, 94, 0.1);
        color: var(--success);
      }

      &.error {
        background: rgba(239, 68, 68, 0.1);
        color: var(--error);
      }
    }

    // Plugins section
    .loading-state,
    .empty-state {
      text-align: center;
      padding: 48px 24px;
      color: var(--text-tertiary);
    }

    .empty-icon {
      font-size: 48px;
      display: block;
      margin-bottom: 12px;
      opacity: 0.5;
    }

    .plugins-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .plugin-card {
      background: var(--bg-surface);
      border-radius: 8px;
      padding: 16px;

      &.unavailable {
        opacity: 0.7;
      }
    }

    .plugin-header {
      display: flex;
      align-items: flex-start;
      gap: 12px;
    }

    .plugin-icon {
      font-size: 28px;
    }

    .plugin-info {
      flex: 1;

      h3 {
        margin: 0 0 4px 0;
        font-size: 14px;
        font-weight: 500;
        color: var(--text-primary);
      }

      p {
        margin: 0;
        font-size: 12px;
        color: var(--text-tertiary);
      }
    }

    .plugin-status {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--text-tertiary);

      .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--error);
      }

      &.available .status-dot {
        background: var(--success);
      }
    }

    .install-hint {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 12px;
      padding: 10px 12px;
      background: var(--bg-elevated);
      border-radius: 6px;
      font-size: 12px;

      .hint-icon {
        font-size: 14px;
      }

      code {
        font-family: monospace;
        color: var(--accent);
      }
    }

    .plugin-settings {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--border-subtle);
    }

    .plugin-setting-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 0;

      label {
        font-size: 13px;
        color: var(--text-secondary);
      }
    }
  `]
})
export class SettingsModalComponent implements OnInit {
  close = output<void>();

  readonly pluginService = inject(PluginService);
  private readonly electronService = inject(ElectronService);

  readonly activeTab = signal<SettingsTab>('general');

  // General settings
  readonly settings = signal<GeneralSettings>({
    disableRendering: false,
    previewQuality: 'medium'
  });

  // Storage state
  readonly totalCacheSize = signal(0);
  readonly cacheLoading = signal(false);
  readonly cacheStatus = signal<{ success: boolean; message: string } | null>(null);

  // Plugin settings cache
  private pluginSettings = new Map<string, Record<string, unknown>>();

  readonly plugins = computed(() => this.pluginService.plugins());

  ngOnInit(): void {
    this.loadSettings();
    this.refreshCacheSize();
    this.loadPluginSettings();
  }

  private loadSettings(): void {
    try {
      const stored = localStorage.getItem('bookforge-settings');
      if (stored) {
        const parsed = JSON.parse(stored);
        this.settings.set({ ...this.settings(), ...parsed });
      }
    } catch {
      // Ignore
    }
  }

  private saveSettings(): void {
    localStorage.setItem('bookforge-settings', JSON.stringify(this.settings()));
  }

  updateSetting<K extends keyof GeneralSettings>(key: K, value: GeneralSettings[K]): void {
    this.settings.update(s => ({ ...s, [key]: value }));
    this.saveSettings();
  }

  async refreshCacheSize(): Promise<void> {
    this.cacheLoading.set(true);
    try {
      const size = await this.electronService.getTotalCacheSize();
      this.totalCacheSize.set(size);
    } catch (err) {
      console.error('Failed to get cache size:', err);
    } finally {
      this.cacheLoading.set(false);
    }
  }

  async clearAllCache(): Promise<void> {
    this.cacheLoading.set(true);
    this.cacheStatus.set(null);

    try {
      const result = await this.electronService.clearAllCache();
      this.totalCacheSize.set(0);

      if (result) {
        this.cacheStatus.set({
          success: true,
          message: `Cleared ${result.cleared} cached files (${this.formatBytes(result.freedBytes)} freed)`
        });
      } else {
        this.cacheStatus.set({
          success: true,
          message: 'Cache cleared'
        });
      }

      setTimeout(() => this.cacheStatus.set(null), 5000);
    } catch (err) {
      this.cacheStatus.set({
        success: false,
        message: `Failed to clear cache: ${err}`
      });
    } finally {
      this.cacheLoading.set(false);
    }
  }

  formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  }

  // Plugin methods
  private async loadPluginSettings(): Promise<void> {
    for (const plugin of this.plugins()) {
      const settings = await this.pluginService.getSettings(plugin.id);
      this.pluginSettings.set(plugin.id, settings);
    }
  }

  getPluginIcon(plugin: PluginInfo): string {
    if (plugin.capabilities.includes('ocr')) return '🔤';
    if (plugin.capabilities.includes('tts')) return '🔊';
    if (plugin.capabilities.includes('export')) return '📤';
    return '🔌';
  }

  getPluginSetting(pluginId: string, key: string): unknown {
    return this.pluginSettings.get(pluginId)?.[key];
  }

  async setPluginSetting(pluginId: string, key: string, value: unknown): Promise<void> {
    const current = this.pluginSettings.get(pluginId) || {};
    current[key] = value;
    this.pluginSettings.set(pluginId, current);
    await this.pluginService.updateSettings(pluginId, current);
  }
}
