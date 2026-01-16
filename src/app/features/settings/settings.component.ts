import { Component, inject, signal, computed, ChangeDetectionStrategy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { SettingsService, SettingsSection, SettingField } from '../../core/services/settings.service';
import { PluginService, PluginInfo } from '../../core/services/plugin.service';
import { ElectronService } from '../../core/services/electron.service';
import { DesktopButtonComponent } from '../../creamsicle-desktop';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [CommonModule, FormsModule, DesktopButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="settings-container">
      <!-- Header -->
      <div class="settings-header">
        <button class="back-btn" (click)="goBack()">
          <span class="back-icon">←</span>
        </button>
        <h1>Settings</h1>
      </div>

      <div class="settings-layout">
        <!-- Sidebar -->
        <div class="settings-sidebar">
          <div class="section-list">
            @for (section of allSections(); track section.id) {
              <button
                class="section-item"
                [class.active]="selectedSection() === section.id"
                (click)="selectSection(section.id)"
              >
                <span class="section-icon">{{ section.icon || '⚙️' }}</span>
                <span class="section-name">{{ section.name }}</span>
                @if (section.isPlugin) {
                  <span class="plugin-badge">Plugin</span>
                }
              </button>
            }
          </div>
        </div>

        <!-- Content -->
        <div class="settings-content">
          @if (currentSection(); as section) {
            <div class="section-header">
              <h2>{{ section.name }}</h2>
              @if (section.description) {
                <p class="section-description">{{ section.description }}</p>
              }

              <!-- Plugin availability status -->
              @if (section.isPlugin) {
                @if (getPluginForSection(section); as plugin) {
                  <div class="plugin-status" [class.available]="plugin.available" [class.unavailable]="!plugin.available">
                    @if (plugin.available) {
                      <span class="status-icon">✓</span>
                      <span>Available (v{{ plugin.availabilityDetails?.version || 'unknown' }})</span>
                    } @else {
                      <span class="status-icon">⚠</span>
                      <span>{{ plugin.availabilityDetails?.error || 'Not available' }}</span>
                      @if (plugin.availabilityDetails?.installInstructions) {
                        <div class="install-hint">{{ plugin.availabilityDetails?.installInstructions }}</div>
                      }
                    }
                  </div>
                }
              }
            </div>

            <!-- Storage section has custom UI -->
            @if (section.id === 'storage') {
              <div class="storage-section">
                <div class="storage-item">
                  <div class="storage-info">
                    <h3>Page Render Cache</h3>
                    <p>Cached page images for faster loading. Located in ~/Documents/BookForge/cache/</p>
                    <div class="storage-size">
                      @if (cacheLoading()) {
                        <span class="size-loading">Calculating...</span>
                      } @else {
                        <span class="size-value">{{ formatBytes(totalCacheSize()) }}</span>
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
                      Clear All Cache
                    </desktop-button>
                  </div>
                </div>

                @if (clearCacheStatus()) {
                  <div class="status-message" [class.success]="clearCacheStatus()!.success" [class.error]="!clearCacheStatus()!.success">
                    {{ clearCacheStatus()!.message }}
                  </div>
                }
              </div>
            } @else {
              <div class="fields-list">
                @for (field of section.fields; track field.key) {
                  <div class="field-row">
                    <div class="field-info">
                      <label class="field-label" [for]="field.key">{{ field.label }}</label>
                      @if (field.description) {
                        <p class="field-description">{{ field.description }}</p>
                      }
                    </div>
                    <div class="field-control">
                      @switch (field.type) {
                        @case ('boolean') {
                          <label class="toggle">
                            <input
                              type="checkbox"
                              [id]="field.key"
                              [checked]="getFieldValue(field)"
                              (change)="setFieldValue(field, $any($event.target).checked)"
                            />
                            <span class="toggle-slider"></span>
                          </label>
                        }
                        @case ('number') {
                          <input
                            type="number"
                            class="number-input"
                            [id]="field.key"
                            [value]="getFieldValue(field)"
                            [min]="field.min"
                            [max]="field.max"
                            (change)="setFieldValue(field, +$any($event.target).value)"
                          />
                        }
                        @case ('select') {
                          <select
                            class="select-input"
                            [id]="field.key"
                            [value]="getFieldValue(field)"
                            (change)="setFieldValue(field, $any($event.target).value)"
                          >
                            @for (option of field.options; track option.value) {
                              <option [value]="option.value">{{ option.label }}</option>
                            }
                          </select>
                        }
                        @case ('path') {
                          <div class="path-input-group">
                            <input
                              type="text"
                              class="text-input path-input"
                              [id]="field.key"
                              [value]="getFieldValue(field)"
                              [placeholder]="field.placeholder || 'Enter path...'"
                              (change)="setFieldValue(field, $any($event.target).value)"
                            />
                          </div>
                        }
                        @default {
                          <input
                            type="text"
                            class="text-input"
                            [id]="field.key"
                            [value]="getFieldValue(field)"
                            [placeholder]="field.placeholder || ''"
                            (change)="setFieldValue(field, $any($event.target).value)"
                          />
                        }
                      }
                    </div>
                  </div>
                }
              </div>

              <div class="section-actions">
                <desktop-button variant="ghost" size="sm" (click)="resetSection(section.id)">
                  Reset to Defaults
                </desktop-button>
              </div>
            }
          }
        </div>
      </div>
    </div>
  `,
  styles: [`
    @use '../../creamsicle-desktop/styles/variables' as *;

    .settings-container {
      height: 100vh;
      display: flex;
      flex-direction: column;
      background: var(--bg-base);
    }

    .settings-header {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-md);
      padding: var(--ui-spacing-md) var(--ui-spacing-lg);
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border-subtle);
      -webkit-app-region: drag;

      h1 {
        margin: 0;
        font-size: var(--ui-font-xl);
        font-weight: $font-weight-semibold;
        color: var(--text-primary);
      }
    }

    .back-btn {
      -webkit-app-region: no-drag;
      width: 32px;
      height: 32px;
      border: none;
      background: var(--bg-elevated);
      color: var(--text-secondary);
      border-radius: $radius-sm;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;

      &:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }
    }

    .settings-layout {
      flex: 1;
      display: flex;
      overflow: hidden;
    }

    .settings-sidebar {
      width: 220px;
      background: var(--bg-surface);
      border-right: 1px solid var(--border-subtle);
      overflow-y: auto;
    }

    .section-list {
      padding: var(--ui-spacing-sm);
    }

    .section-item {
      width: 100%;
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-sm);
      padding: var(--ui-spacing-sm) var(--ui-spacing-md);
      background: none;
      border: none;
      border-radius: $radius-md;
      color: var(--text-secondary);
      font-size: var(--ui-font-sm);
      text-align: left;
      cursor: pointer;
      transition: all $duration-fast $ease-out;

      &:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }

      &.active {
        background: var(--accent-muted);
        color: var(--accent);
      }
    }

    .section-icon {
      font-size: 16px;
    }

    .section-name {
      flex: 1;
    }

    .plugin-badge {
      font-size: 10px;
      padding: 2px 6px;
      background: var(--accent-muted);
      color: var(--accent);
      border-radius: 4px;
    }

    .settings-content {
      flex: 1;
      overflow-y: auto;
      padding: var(--ui-spacing-xl);
    }

    .section-header {
      margin-bottom: var(--ui-spacing-xl);

      h2 {
        margin: 0 0 var(--ui-spacing-xs) 0;
        font-size: var(--ui-font-lg);
        font-weight: $font-weight-semibold;
        color: var(--text-primary);
      }
    }

    .section-description {
      margin: 0;
      color: var(--text-tertiary);
      font-size: var(--ui-font-sm);
    }

    .plugin-status {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-sm);
      margin-top: var(--ui-spacing-md);
      padding: var(--ui-spacing-sm) var(--ui-spacing-md);
      border-radius: $radius-md;
      font-size: var(--ui-font-sm);

      &.available {
        background: rgba(34, 197, 94, 0.1);
        color: var(--success);
      }

      &.unavailable {
        background: rgba(239, 68, 68, 0.1);
        color: var(--error);
      }
    }

    .status-icon {
      font-size: 14px;
    }

    .install-hint {
      margin-top: var(--ui-spacing-xs);
      font-family: monospace;
      font-size: var(--ui-font-xs);
      opacity: 0.8;
    }

    .fields-list {
      display: flex;
      flex-direction: column;
      gap: var(--ui-spacing-lg);
    }

    .field-row {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--ui-spacing-xl);
      padding: var(--ui-spacing-md);
      background: var(--bg-surface);
      border-radius: $radius-md;
    }

    .field-info {
      flex: 1;
      min-width: 0;
    }

    .field-label {
      display: block;
      font-size: var(--ui-font-base);
      font-weight: $font-weight-medium;
      color: var(--text-primary);
      margin-bottom: var(--ui-spacing-xs);
    }

    .field-description {
      margin: 0;
      font-size: var(--ui-font-sm);
      color: var(--text-tertiary);
    }

    .field-control {
      flex-shrink: 0;
    }

    // Toggle switch
    .toggle {
      position: relative;
      display: inline-block;
      width: 44px;
      height: 24px;

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
        transition: background $duration-fast $ease-out;

        &::before {
          position: absolute;
          content: "";
          height: 18px;
          width: 18px;
          left: 2px;
          bottom: 2px;
          background: var(--text-secondary);
          border-radius: 50%;
          transition: all $duration-fast $ease-out;
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

    .number-input,
    .text-input,
    .select-input {
      padding: var(--ui-spacing-sm) var(--ui-spacing-md);
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: $radius-md;
      color: var(--text-primary);
      font-size: var(--ui-font-sm);

      &:focus {
        outline: none;
        border-color: var(--accent);
      }
    }

    .number-input {
      width: 100px;
      text-align: center;
    }

    .text-input {
      width: 200px;
    }

    .path-input {
      width: 300px;
    }

    .select-input {
      min-width: 150px;

      option {
        background: var(--bg-surface);
      }
    }

    .path-input-group {
      display: flex;
      gap: var(--ui-spacing-sm);
    }

    .section-actions {
      margin-top: var(--ui-spacing-xl);
      padding-top: var(--ui-spacing-lg);
      border-top: 1px solid var(--border-subtle);
    }

    // Storage section styles
    .storage-section {
      display: flex;
      flex-direction: column;
      gap: var(--ui-spacing-lg);
    }

    .storage-item {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--ui-spacing-xl);
      padding: var(--ui-spacing-lg);
      background: var(--bg-surface);
      border-radius: $radius-md;
    }

    .storage-info {
      flex: 1;

      h3 {
        margin: 0 0 var(--ui-spacing-xs) 0;
        font-size: var(--ui-font-base);
        font-weight: $font-weight-medium;
        color: var(--text-primary);
      }

      p {
        margin: 0 0 var(--ui-spacing-md) 0;
        font-size: var(--ui-font-sm);
        color: var(--text-tertiary);
      }
    }

    .storage-size {
      font-size: var(--ui-font-lg);
      font-weight: $font-weight-semibold;
      color: var(--accent);
    }

    .size-loading {
      color: var(--text-tertiary);
      font-weight: normal;
      font-size: var(--ui-font-sm);
    }

    .storage-actions {
      display: flex;
      gap: var(--ui-spacing-sm);
      flex-shrink: 0;
    }

    .status-message {
      padding: var(--ui-spacing-sm) var(--ui-spacing-md);
      border-radius: $radius-md;
      font-size: var(--ui-font-sm);

      &.success {
        background: rgba(34, 197, 94, 0.1);
        color: var(--success);
      }

      &.error {
        background: rgba(239, 68, 68, 0.1);
        color: var(--error);
      }
    }
  `]
})
export class SettingsComponent implements OnInit {
  private readonly router = inject(Router);
  private readonly settingsService = inject(SettingsService);
  private readonly pluginService = inject(PluginService);
  private readonly electronService = inject(ElectronService);

  readonly selectedSection = signal('general');

  // Storage section state
  readonly totalCacheSize = signal(0);
  readonly cacheLoading = signal(false);
  readonly clearCacheStatus = signal<{ success: boolean; message: string } | null>(null);

  // Combine built-in and plugin sections
  readonly allSections = computed(() => {
    return this.settingsService.sections();
  });

  // Get current section
  readonly currentSection = computed(() => {
    return this.allSections().find(s => s.id === this.selectedSection());
  });

  ngOnInit(): void {
    // Load cache size on init
    this.refreshCacheSize();
  }

  goBack(): void {
    this.router.navigate(['/pdf-picker']);
  }

  selectSection(sectionId: string): void {
    this.selectedSection.set(sectionId);
  }

  getFieldValue(field: SettingField): unknown {
    // For plugin settings, prefix with plugin ID
    const section = this.currentSection();
    if (section?.isPlugin) {
      const pluginId = section.id.replace('plugin-', '');
      return this.settingsService.get(`${pluginId}.${field.key}`) ?? field.default;
    }
    return this.settingsService.get(field.key) ?? field.default;
  }

  setFieldValue(field: SettingField, value: unknown): void {
    const section = this.currentSection();
    if (section?.isPlugin) {
      const pluginId = section.id.replace('plugin-', '');
      this.settingsService.set(`${pluginId}.${field.key}`, value);
      // Also update plugin settings in main process
      this.updatePluginSettings(pluginId);
    } else {
      this.settingsService.set(field.key, value);
    }
  }

  private async updatePluginSettings(pluginId: string): Promise<void> {
    const section = this.allSections().find(s => s.id === `plugin-${pluginId}`);
    if (!section) return;

    const settings: Record<string, unknown> = {};
    for (const field of section.fields) {
      settings[field.key] = this.settingsService.get(`${pluginId}.${field.key}`) ?? field.default;
    }

    await this.pluginService.updateSettings(pluginId, settings);
  }

  resetSection(sectionId: string): void {
    this.settingsService.resetSection(sectionId);
  }

  getPluginForSection(section: SettingsSection): PluginInfo | undefined {
    if (!section.isPlugin) return undefined;
    const pluginId = section.id.replace('plugin-', '');
    return this.pluginService.getPlugin(pluginId);
  }

  // Cache management methods
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
    this.clearCacheStatus.set(null);

    try {
      const result = await this.electronService.clearAllCache();
      this.totalCacheSize.set(0);

      if (result) {
        this.clearCacheStatus.set({
          success: true,
          message: `Cleared ${result.cleared} cached files (${this.formatBytes(result.freedBytes)} freed)`
        });
      } else {
        this.clearCacheStatus.set({
          success: true,
          message: 'Cache cleared'
        });
      }

      // Clear status after 5 seconds
      setTimeout(() => this.clearCacheStatus.set(null), 5000);
    } catch (err) {
      this.clearCacheStatus.set({
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
}
