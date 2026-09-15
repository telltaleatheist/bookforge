import { Component, inject, signal, computed, ChangeDetectionStrategy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, ActivatedRoute } from '@angular/router';
import { SettingsService, SettingsSection, SettingField } from '../../core/services/settings.service';
import { PluginService, PluginInfo } from '../../core/services/plugin.service';
import { ElectronService, OrpheusBatchConfig } from '../../core/services/electron.service';
import { LibraryService } from '../../core/services/library.service';
import { DesktopButtonComponent, DesktopSelectComponent, DesktopSelectItems } from '../../creamsicle-desktop';
import { AddOnsPanelComponent } from './components/add-ons-panel.component';
import { AiSetupWizardComponent } from '../ai-setup/ai-setup-wizard.component';
import { ComponentService } from '../../core/services/component.service';
import { PipelineDefaultsPanelComponent } from './components/pipeline-defaults-panel.component';
import { CrucibleServersPanelComponent } from './components/crucible-servers-panel.component';
import { RemoveAllDataComponent } from '../../shared/remove-all-data.component';

/**
 * One tool-path value as TEXT, whichever shape it arrived in.
 *
 * A tool-paths record holds strings for the path rows and real BOOLEANS for the
 * checkbox keys (electron/tool-paths.ts coerces the renderer's 'true' at the IPC
 * boundary, deliberately, so main-process readers can ask `=== true`). Every
 * comparison in this component goes through here so that a boolean and the
 * string that produced it are the same answer.
 */
function toolPathText(raw: string | boolean | undefined): string {
  if (typeof raw === 'string') return raw;
  return raw === true ? 'true' : '';
}

@Component({
  selector: 'app-settings',
  standalone: true,
  /*
   * FIVE COMPONENTS LEFT THIS LIST ON 2026-09-14, and their files are deleted:
   * OrpheusVoicesPanel, HiggsVoicesPanel, RvcEnhancementPanel,
   * WhisperModelsPanel and MultiWorkerToggle. Nothing else in src/ mounted any
   * of them — this page and the first-run wizard were their only two hosts,
   * and both lost the sections/steps that did (audit sections 6 and 7).
   */
  imports: [CommonModule, FormsModule, DesktopButtonComponent, DesktopSelectComponent, AddOnsPanelComponent, AiSetupWizardComponent, PipelineDefaultsPanelComponent, CrucibleServersPanelComponent, RemoveAllDataComponent],
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

            <!-- Library section has custom UI -->
            @if (section.id === 'library') {
              <div class="library-section">
                <div class="field-row">
                  <div class="field-info">
                    <label class="field-label">Library Location</label>
                    <p class="field-description">All projects, audiobooks, and cache files are stored here</p>
                  </div>
                  <div class="field-control">
                    <div class="path-input-group">
                      <input
                        type="text"
                        class="text-input path-input library-path-input"
                        [value]="currentLibraryPath()"
                        placeholder="Select a folder..."
                        readonly
                      />
                      <desktop-button
                        variant="ghost"
                        size="sm"
                        (click)="browseForLibraryFolder()"
                      >
                        Browse...
                      </desktop-button>
                    </div>
                  </div>
                </div>

                @if (libraryChangeStatus(); as status) {
                  <div class="status-message" [class.success]="status.success" [class.error]="!status.success">
                    {{ status.message }}
                  </div>
                }

                <div class="save-section">
                  <desktop-button variant="primary" size="md" (click)="saveLibrary()" [disabled]="!libraryDirty() || librarySaving()">
                    {{ librarySaving() ? 'Saving…' : (libraryDirty() ? 'Save Changes' : 'Saved') }}
                  </desktop-button>
                  @if (libraryDirty()) {
                    <desktop-button variant="ghost" size="md" (click)="discardLibrary()" [disabled]="librarySaving()">
                      Discard
                    </desktop-button>
                    <span class="unsaved-hint">You have unsaved changes</span>
                  }
                </div>

                <div class="help-text">
                  <p>
                    <strong>Note:</strong> Changing the library location does not move existing files.
                    If you've copied your library to a new location, select the new folder here.
                  </p>
                  <p style="margin-top: 8px;">
                    <strong>Current structure:</strong><br/>
                    {{ currentLibraryPath() }}/projects/ - Project files, audiobook output<br/>
                    ~/Documents/BookForge/cache/ - Page render cache (machine-local, not synced)
                  </p>
                </div>

                <!--
                  THE SECOND COPY OF <app-remove-all-data /> IS GONE FROM HERE
                  (2026-09-14, audit sections 3.1 and 3.3). One in-app uninstall
                  is enough, and it belongs on Storage, beside the caches and
                  the archive move — which is where somebody looking to reclaim
                  disk actually goes. Two buttons that erase the same thing is
                  two chances to press one by accident.
                -->
              </div>
            } @else if (section.id === 'storage') {
              <!-- Storage section has custom UI -->
              <div class="storage-section">
                <div class="storage-item">
                  <div class="storage-info">
                    <h3>Page Render Cache</h3>
                    <p>Cached page images for faster loading. Located in ~/Documents/BookForge/cache/. Caches for documents not opened in 30 days are cleared automatically at startup.</p>
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

                <!-- Protect professionally-read uploads: relocate any that still sit
                     in the disposable output/ folder into the protected archive/
                     folder so "Delete output" can never destroy them. -->
                <div class="storage-item">
                  <div class="storage-info">
                    <h3>Protect professionally-read audiobooks</h3>
                    <p>Move directly-uploaded (professionally-read) audiobooks out of the disposable output/ folder and into the protected archive/ folder, so deleting pipeline output can never remove them. Safe to run repeatedly; TTS-generated books are left untouched.</p>
                    @if (archiveMigrationResult(); as r) {
                      <div class="status-message" [class.success]="r.success" [class.error]="!r.success">
                        Migrated {{ r.migrated }}, skipped {{ r.skipped }}, failed {{ r.failed }}.
                      </div>
                      @for (b of r.books; track b.projectId) {
                        @if (b.status !== 'skipped') {
                          <div class="archive-book-row" [class.error]="b.status === 'failed'">
                            <span class="abr-status">{{ b.status === 'migrated' ? '✓' : '✕' }}</span>
                            <span class="abr-title">{{ b.title }}</span>
                            @if (b.reason) { <span class="abr-reason">{{ b.reason }}</span> }
                            @if (b.orphans && b.orphans.length) { <span class="abr-reason">left {{ b.orphans.length }} locked file(s) in output/</span> }
                          </div>
                        }
                      }
                    }
                  </div>
                  <div class="storage-actions">
                    <desktop-button variant="primary" size="sm" (click)="migrateAudiobooksToArchive()" [disabled]="archiveMigrating()">
                      {{ archiveMigrating() ? 'Moving…' : 'Move to archive' }}
                    </desktop-button>
                  </div>
                </div>

                <!-- Full uninstall of OUR data (keeps the user's library/books). -->
                <app-remove-all-data />
              </div>
            } @else if (section.id === 'ai') {
              <!-- AI Configuration — the AI Setup wizard, embedded (supersedes the old provider-card UI) -->
              <app-ai-setup-wizard [embedded]="true" />
            } @else if (section.id === 'bookshelf') {
              <!-- Bookshelf Server Section -->
              <div class="bookshelf-section">
                <!-- Server Status -->
                <div class="server-status-card" [class.running]="bookshelfStatus()?.running">
                  <div class="status-indicator">
                    <span class="status-dot"></span>
                    <span class="status-text">
                      {{ bookshelfStatus()?.running ? 'Running' : 'Stopped' }}
                    </span>
                  </div>
                  @if (bookshelfStatus()?.running) {
                    <div class="server-addresses">
                      <h4>Access URLs</h4>
                      @for (address of bookshelfStatus()?.addresses || []; track address) {
                        <a class="server-address" [href]="address" target="_blank">{{ address }}</a>
                      }
                    </div>
                  }
                </div>

                <!-- Configuration -->
                <div class="settings-group">
                  <h4>Configuration</h4>

                  <!-- Port -->
                  <div class="field-row">
                    <div class="field-info">
                      <label class="field-label">Port</label>
                      <p class="field-description">Server port (default: 8765)</p>
                    </div>
                    <div class="field-control">
                      <input
                        type="number"
                        class="number-input"
                        [value]="bookshelfConfig().port"
                        min="1"
                        max="65535"
                        (change)="updateBookshelfPort(+$any($event.target).value)"
                        [disabled]="bookshelfStatus()?.running ?? false"
                      />
                    </div>
                  </div>
                </div>

                <div class="save-section">
                  <desktop-button variant="primary" size="md" (click)="saveBookshelf()" [disabled]="!bookshelfDirty() || bookshelfSaving()">
                    {{ bookshelfSaving() ? 'Saving…' : (bookshelfDirty() ? 'Save Changes' : 'Saved') }}
                  </desktop-button>
                  @if (bookshelfDirty()) {
                    <desktop-button variant="ghost" size="md" (click)="discardBookshelf()" [disabled]="bookshelfSaving()">
                      Discard
                    </desktop-button>
                    <span class="unsaved-hint">You have unsaved changes</span>
                  }
                </div>

                <!-- Control Buttons -->
                <div class="server-controls">
                  @if (bookshelfStatus()?.running) {
                    <desktop-button
                      variant="danger"
                      size="md"
                      (click)="stopBookshelf()"
                      [disabled]="bookshelfLoading()"
                    >
                      {{ bookshelfLoading() ? 'Stopping...' : 'Stop Server' }}
                    </desktop-button>
                  } @else {
                    <desktop-button
                      variant="primary"
                      size="md"
                      (click)="startBookshelf()"
                      [disabled]="bookshelfLoading()"
                    >
                      {{ bookshelfLoading() ? 'Starting...' : 'Start Server' }}
                    </desktop-button>
                  }
                </div>

                @if (bookshelfError(); as error) {
                  <div class="status-message error">
                    {{ error }}
                  </div>
                }

                <!-- Help text -->
                <div class="help-text">
                  <p>
                    Shares audiobooks from your BookForge library over the network.
                    Access from any device using the URLs shown above.
                  </p>
                </div>
              </div>
            } @else if (section.id === 'tab-recorder') {
              <!-- Tab Recorder Section.
                   WAS "TTS Server", and the TTS half is deleted (Phase 16 step 8).
                   What this endpoint does now is one thing: the browser extension
                   captures a tab's audio and hands the raw samples here, because a
                   browser has no filesystem and no ffmpeg and BookForge has both.
                   Speech does not come through here any more - the extension holds
                   a Crucible's card itself and reads pages with BookForge shut. -->
              <div class="bookshelf-section">
                <!-- Server Status -->
                <div class="server-status-card" [class.running]="tabRecordStatus()?.running">
                  <div class="status-indicator">
                    <span class="status-dot"></span>
                    <span class="status-text">
                      {{ tabRecordStatus()?.running ? 'Running' : 'Stopped' }}
                    </span>
                  </div>
                  @if (tabRecordStatus()?.running) {
                    <div class="server-addresses">
                      <h4>WebSocket URLs</h4>
                      @for (address of tabRecordStatus()?.addresses || []; track address) {
                        <span class="server-address">{{ address }}</span>
                      }
                    </div>
                  }
                </div>

                <!-- Configuration -->
                <div class="settings-group">
                  <h4>Configuration</h4>

                  <!-- Access Token -->
                  <div class="field-row">
                    <div class="field-info">
                      <label class="field-label">Access Token</label>
                      <p class="field-description">
                        Only needed when the browser is on ANOTHER machine. A local
                        BookForge trusts the extension by its origin, so the extension's
                        token box stays empty in the normal case.
                      </p>
                    </div>
                    <div class="field-control">
                      <div class="path-input-group">
                        <input
                          type="text"
                          class="text-input token-input"
                          readonly
                          [value]="tabRecordTokenVisible() ? (tabRecordStatus()?.token || '') : '••••••••••••••••'"
                        />
                        <desktop-button variant="ghost" size="sm" (click)="tabRecordTokenVisible.set(!tabRecordTokenVisible())">
                          {{ tabRecordTokenVisible() ? 'Hide' : 'Show' }}
                        </desktop-button>
                        <desktop-button variant="ghost" size="sm" (click)="copyTabRecordToken()">
                          {{ tabRecordCopied() ? 'Copied!' : 'Copy' }}
                        </desktop-button>
                      </div>
                    </div>
                  </div>

                  <!-- Port -->
                  <div class="field-row">
                    <div class="field-info">
                      <label class="field-label">Port</label>
                      <p class="field-description">WebSocket port (default: 8766). Changing it restarts the server.</p>
                    </div>
                    <div class="field-control">
                      <input
                        type="number"
                        class="number-input"
                        [value]="tabRecordViewPort()"
                        min="1"
                        max="65535"
                        (change)="updateTabRecordPort(+$any($event.target).value)"
                        [disabled]="tabRecordSaving()"
                      />
                    </div>
                  </div>

                  <!-- LAN Access -->
                  <div class="field-row">
                    <div class="field-info">
                      <label class="field-label">Allow LAN Access</label>
                      <p class="field-description">Accept recordings from a browser on another machine. Off = this computer only.</p>
                    </div>
                    <div class="field-control">
                      <label class="toggle">
                        <input
                          type="checkbox"
                          [checked]="tabRecordViewHost() === '0.0.0.0'"
                          (change)="toggleTabRecordLan($any($event.target).checked)"
                          [disabled]="tabRecordSaving()"
                        />
                        <span class="toggle-slider"></span>
                      </label>
                    </div>
                  </div>
                </div>

                <!--
                  EVERY TTS CONTROL THAT STOOD HERE IS DELETED (Phase 16 step 8,
                  docs/EXTENSION-TO-CRUCIBLE-PLAN.md section 0's two-column table).

                  "Voice Engine" - dropped. There is one narration engine, and when
                  there is a second it arrives as a COLUMN of a voice list, never a
                  selector: a voice implies its engine (section 4a). The Streaming
                  tab still has its own engine toggle for the engine BookForge
                  itself runs; that is a different fact from what a browser
                  extension speaks with.

                  "Voice" - CARRIED, to the extension. Its list is the selected
                  Crucible's GET /v1/voices, which is current because it is the
                  server that holds the weights; a BookForge-side picker for a
                  client BookForge no longer serves would be a second owner of one
                  fact, and the stale one.

                  "Generation Device" and "enable multiple TTS workers" were
                  already deleted on 2026-09-14 (both inert). Neither is coming
                  back: the device is the server's ("always chosen by the crucible
                  server") and the worker count was XTTS's.
                -->

                <div class="save-section">
                  <desktop-button variant="primary" size="md" (click)="saveTabRecordServer()" [disabled]="!tabRecordDirty() || tabRecordSaving()">
                    {{ tabRecordSaving() ? 'Saving…' : (tabRecordDirty() ? 'Save Changes' : 'Saved') }}
                  </desktop-button>
                  @if (tabRecordDirty()) {
                    <desktop-button variant="ghost" size="md" (click)="discardTabRecordServer()" [disabled]="tabRecordSaving()">
                      Discard
                    </desktop-button>
                    <span class="unsaved-hint">Saving restarts the server</span>
                  }
                </div>

                @if (tabRecordError(); as error) {
                  <div class="status-message error">
                    {{ error }}
                  </div>
                }

                <!-- Help text -->
                <div class="help-text">
                  <p>
                    The BookForge Reader extension's <strong>Record this tab</strong> sends
                    raw audio here and ffmpeg writes the FLAC. Starts automatically with
                    BookForge. Protocol reference: docs/TAB_RECORDER.md in the repository.
                  </p>
                </div>
              </div>
            } @else if (section.id === 'tools') {
              <!-- Advanced Section (tool-path overrides, scratch dir, WSL) -->
              <div class="tools-section">
                @if (toolPathsLoading()) {
                  <p class="loading-hint">Loading tool paths...</p>
                }

                <!--
                  Conda Path — hidden on packaged builds (they run on the
                  bundled relocatable env and never need conda). Shown in dev /
                  bring-your-own setups.

                  DELETE WITH THE SPAWN LAYER (audit section 3.15). Both
                  readers of "tool-paths.json" -> "condaPath" are the LEGACY
                  LOCAL NARRATOR SPAWN — "narrator-paths.ts" (env resolution for
                  a per-engine conda env) and "narrator-spawn.ts" (the spawn's
                  own conda prefix) — so this row dies in the commit that
                  deletes that layer.

                  THE SWITCH IS ALREADY GONE (2026-09-15,
                  docs/LEGACY-REMOVAL.md); the spawn itself is HELD one more
                  commit, because those files are the surviving record of
                  narrator tuning measured over months and Crucible was found
                  missing one of its knobs (a 7x MLX batch width) on the same
                  day. Removing the door before the reader would strand exactly
                  the machine the audit is run on.
                -->
                @if (!usingBundledEnv()) {
                <div class="tool-row">
                  <div class="tool-info">
                    <h4>Conda</h4>
                    <p class="tool-description">Python environment manager (optional — only for advanced / bring-your-own TTS setups)</p>
                    @if (getToolStatus('conda'); as status) {
                      <div class="tool-status" [class.detected]="status.detected" [class.not-detected]="!status.detected">
                        @if (status.configured) {
                          <span class="status-badge configured">Configured</span>
                        } @else if (status.detected) {
                          <span class="status-badge detected">Auto-detected</span>
                        } @else {
                          <span class="status-badge not-found">Not found</span>
                        }
                        <span class="tool-path">{{ status.path }}</span>
                      </div>
                    }
                  </div>
                  <div class="tool-control">
                    <div class="path-input-group">
                      <input
                        type="text"
                        class="text-input path-input"
                        [value]="getToolPathValue('condaPath')"
                        placeholder="Auto-detect"
                        (change)="updateToolPath('condaPath', $any($event.target).value)"
                      />
                      <desktop-button variant="ghost" size="sm" (click)="browseForToolPath('condaPath')">
                        Browse...
                      </desktop-button>
                    </div>
                  </div>
                </div>
                }

                <!-- FFmpeg Path -->
                <div class="tool-row">
                  <div class="tool-info">
                    <h4>FFmpeg</h4>
                    <p class="tool-description">Audio/video converter (required for audiobook output)</p>
                    @if (getToolStatus('ffmpeg'); as status) {
                      <div class="tool-status" [class.detected]="status.detected" [class.not-detected]="!status.detected">
                        @if (status.configured) {
                          <span class="status-badge configured">Configured</span>
                        } @else if (status.detected) {
                          <span class="status-badge detected">Auto-detected</span>
                        } @else {
                          <span class="status-badge not-found">Not found</span>
                        }
                        <span class="tool-path">{{ status.path }}</span>
                      </div>
                    }
                  </div>
                  <div class="tool-control">
                    <div class="path-input-group">
                      <input
                        type="text"
                        class="text-input path-input"
                        [value]="getToolPathValue('ffmpegPath')"
                        placeholder="Auto-detect"
                        (change)="updateToolPath('ffmpegPath', $any($event.target).value)"
                      />
                      <desktop-button variant="ghost" size="sm" (click)="browseForToolPath('ffmpegPath')">
                        Browse...
                      </desktop-button>
                    </div>
                  </div>
                </div>

                <!-- Tools Python environment -->
                <div class="tool-row">
                  <div class="tool-info">
                    <h4>Tools Python environment</h4>
                    <p class="tool-description">Runs audiobook assembly, session resume, whisper and the metadata tools. BookForge installs its own; point at another only to avoid a second copy.</p>
                    @if (getToolStatus('toolsEnv'); as status) {
                      <div class="tool-status" [class.detected]="status.detected" [class.not-detected]="!status.detected">
                        @if (status.configured) {
                          <span class="status-badge configured">Configured</span>
                        } @else if (status.detected) {
                          <span class="status-badge detected">Installed</span>
                        } @else {
                          <span class="status-badge not-found">Not found</span>
                        }
                        <span class="tool-path">{{ status.path }}</span>
                      </div>
                    }
                  </div>
                  <div class="tool-control">
                    <div class="path-input-group">
                      <input
                        type="text"
                        class="text-input path-input"
                        [value]="getToolPathValue('toolsEnvPath')"
                        placeholder="BookForge's own runtime/tools-env"
                        (change)="updateToolPath('toolsEnvPath', $any($event.target).value)"
                      />
                      <desktop-button variant="ghost" size="sm" (click)="browseForToolPath('toolsEnvPath')">
                        Browse...
                      </desktop-button>
                    </div>
                  </div>
                </div>

                <div class="save-section">
                  <desktop-button variant="primary" size="md" (click)="saveTools()" [disabled]="!toolPathsDirty() || toolPathsSaving()">
                    {{ toolPathsSaving() ? 'Saving…' : (toolPathsDirty() ? 'Save Changes' : 'Saved') }}
                  </desktop-button>
                  @if (toolPathsDirty()) {
                    <desktop-button variant="ghost" size="md" (click)="discardTools()" [disabled]="toolPathsSaving()">
                      Discard
                    </desktop-button>
                    <span class="unsaved-hint">You have unsaved changes</span>
                  }
                </div>

                @if (toolPathsSaveStatus(); as status) {
                  <div class="status-message" [class.success]="status.success" [class.error]="!status.success">
                    {{ status.message }}
                  </div>
                }

                <div class="section-actions">
                  <desktop-button variant="ghost" size="sm" (click)="refreshToolPaths()" [disabled]="toolPathsLoading()">
                    Refresh Detection
                  </desktop-button>
                </div>

                <div class="help-text">
                  <p>
                    <strong>Tip:</strong> Leave paths empty to use auto-detection.
                    The app will search common installation locations for each tool.
                  </p>
                </div>
              </div>
            } @else if (section.id === 'add-ons') {
              <!--
                FOUR SECTIONS WERE DELETED ABOVE THIS ONE (2026-09-14, audit
                docs/SETUP-AND-SETTINGS-AROUND-CRUCIBLE.md section 7): Orpheus,
                Higgs, RVC Enhancement and Speech to Text.

                They existed for a good reason at the time: an engine needs an
                env, a models directory, a doctor and a voice catalog, and
                putting all four on one screen is what made "pick your engine,
                set it up here" readable. Crucible owns all four now, once per
                machine (rollout section 2 ruling 1) — the envs are job types it
                installs, the weights are subjects in its catalog, and
                "crucible doctor" is the doctor — so each page had no content
                left. Orpheus is additionally RETIRED (Owen, 2026-09-14) from
                both the narration and the Listen picker, and Higgs is the one
                engine; the Orpheus spawn layer itself is held until Crucible's
                environment has been audited against it (docs/LEGACY-REMOVAL.md).

                Where each thing went: the environments and the weights are
                installed from the SERVER's own page (Crucible Servers -> Open,
                and BookForge installs what it needs the moment it connects to one).
                The WSL keys the
                Orpheus page owned are read only by that held spawn and die
                with it. wslDistro did not move, because it never belonged to
                Orpheus: its non-legacy reader is crucible/discovery.ts, which finds
                it in tool-paths.json exactly as before.

                WHAT IS LEFT HERE is the three tools BookForge still installs.
              -->
              <div class="addons-hub">
                <div class="addons-group">
                  <h3 class="addons-group-title">General tools</h3>
                  <p class="addons-group-sub">Calibre (ebook conversion), Tesseract (OCR), and the Foundry engine binary — the only downloads BookForge still owns. Everything else an engine needs is installed on the Crucible that runs it.</p>
                  <app-add-ons-panel [only]="generalAddOnIds"></app-add-ons-panel>
                </div>
              </div>
            } @else if (section.id === 'crucible') {
              <!-- The Crucible servers the queue may use: this machine's, the
                   servers, their rank and their enable switches. -->
              <app-crucible-servers-panel></app-crucible-servers-panel>
            } @else if (section.id === 'pipeline-defaults') {
              <!-- Default AI / TTS / output selections the pipeline seeds from. -->
              <app-pipeline-defaults-panel></app-pipeline-defaults-panel>
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
                          <desktop-select
                            class="select-input"
                            [id]="field.key"
                            [options]="toSelectOptions(field.options)"
                            [ngModel]="getFieldValue(field)"
                            (ngModelChange)="setFieldValue(field, $event)"
                          ></desktop-select>
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
                            <desktop-button
                              variant="ghost"
                              size="sm"
                              (click)="browseForFolder(field)"
                            >
                              Browse...
                            </desktop-button>
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

                @if (section.id === 'general') {
                  <!-- Settings is the only post-setup hub (the Configuration rail
                       item was removed); the guided walkthrough stays reachable
                       from here for hand-holding after a library/machine change. -->
                  <div class="field-row">
                    <div class="field-info">
                      <label class="field-label">Guided setup</label>
                      <p class="field-description">Walk through the first-run setup again — library location, AI, voices, language packs, and optional tools — step by step.</p>
                    </div>
                    <div class="field-control">
                      <desktop-button variant="ghost" size="sm" (click)="openGuidedSetup()">
                        Run guided setup…
                      </desktop-button>
                    </div>
                  </div>
                }
              </div>

              <!-- Save Button -->
              <div class="save-section">
                <desktop-button
                  variant="primary"
                  size="md"
                  (click)="saveSettings()"
                  [disabled]="!hasUnsavedChanges()"
                >
                  {{ hasUnsavedChanges() ? 'Save Changes' : 'Saved' }}
                </desktop-button>
                @if (hasUnsavedChanges()) {
                  <span class="unsaved-hint">You have unsaved changes</span>
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
      /* THE CONTENT AREA, NOT THE VIEWPORT. Settings renders inside the app
         shell (app.ts: desktop-window's titlebar above and status bar below,
         then .app-content with height 100% and overflow hidden), so a 100vh
         page is taller than the space it is given by exactly that chrome - and
         the bottom of .settings-content, which is the scroll container, sits
         below the window with no way to reach it. Owen, 2026-09-08: "settings
         isnt letting me scroll to the bottom", on the Higgs voice catalog. Same
         bug and same fix as the first-run wizard's .setup-card (see its comment:
         100vh "overran the bottom and hid the Next button"). min-height 0 so the
         column's children may shrink below their content and let the scroller do
         its job. */
      height: 100%;
      min-height: 0;
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
      /* A flex item's min-height defaults to auto, which refuses to shrink
         below its content - the height chain has to be definite all the way to
         .settings-content or the scroller never gets a bounded height. */
      min-height: 0;
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
        background: color-mix(in srgb, var(--accent) 15%, transparent);
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
      background: color-mix(in srgb, var(--accent) 15%, transparent);
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
        background: var(--success-bg);
        color: var(--success);
      }

      &.unavailable {
        background: var(--error-bg);
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

    // Device picker (Generation Device group)
    .worker-options {
      display: flex;
      gap: 8px;
      margin: 4px 0 6px;
      align-items: center;
    }
    .batch-input {
      width: 88px;
      padding: 6px 10px;
      border: 1px solid var(--border-default);
      border-radius: 6px;
      background: var(--bg-surface, var(--surface-1));
      color: var(--text-primary);
      font-size: 14px;
    }
    .batch-input:disabled { opacity: 0.5; cursor: not-allowed; }
    .worker-btn {
      min-width: 56px;
      padding: 6px 12px;
      border: 1px solid var(--border-default);
      border-radius: 6px;
      background: var(--bg-surface, var(--surface-1));
      color: var(--text-secondary);
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s;
    }
    .worker-btn:hover:not(:disabled) {
      color: var(--text-primary);
      border-color: var(--text-secondary);
    }
    .worker-btn.selected {
      background: var(--accent, var(--accent-primary));
      border-color: var(--accent, var(--accent-primary));
      color: #1a1a1a;
    }
    .worker-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .hint {
      display: block;
      font-size: var(--ui-font-sm);
      color: var(--text-tertiary);
      margin-top: 2px;
    }
    .hint.warn-text {
      color: #f59e0b;
    }
    .hint.hint-error {
      color: var(--error);
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

    .token-input {
      width: 280px;
      font-family: monospace;
    }

    .library-path-input {
      width: 400px;
    }

    .library-section {
      display: flex;
      flex-direction: column;
      gap: var(--ui-spacing-lg);
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

    .save-section {
      margin-top: var(--ui-spacing-xl);
      padding: var(--ui-spacing-lg);
      background: var(--bg-elevated);
      border-radius: $radius-md;
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-md);

      .unsaved-hint {
        font-size: var(--ui-font-sm);
        color: var(--text-warning);
      }
    }

    .section-actions {
      margin-top: var(--ui-spacing-lg);
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

    .archive-book-row {
      display: flex;
      align-items: baseline;
      gap: var(--ui-spacing-sm);
      margin-top: var(--ui-spacing-xs);
      font-size: var(--ui-font-sm);
      color: var(--text-secondary);

      &.error { color: var(--error); }

      .abr-status { flex-shrink: 0; }
      .abr-title { font-weight: $font-weight-medium; color: var(--text-primary); }
      .abr-reason { color: var(--text-tertiary); }
    }

    .status-message {
      padding: var(--ui-spacing-sm) var(--ui-spacing-md);
      border-radius: $radius-md;
      font-size: var(--ui-font-sm);

      &.success {
        background: var(--success-bg);
        color: var(--success);
      }

      &.error {
        background: var(--error-bg);
        color: var(--error);
      }
    }

    // AI Section Styles
    .ai-section {
      display: flex;
      flex-direction: column;
      gap: var(--ui-spacing-xl);
    }

    .ai-wizard-link {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-md);
      flex-wrap: wrap;
    }
    .open-wizard-btn {
      padding: 0.5rem 0.9rem;
      border: 1px solid var(--accent);
      border-radius: 6px;
      background: var(--accent-subtle, transparent);
      color: var(--accent);
      font-size: 0.875rem;
      font-weight: 600;
      cursor: pointer;
    }
    .open-wizard-btn:hover { background: var(--accent); color: var(--bg-base); }
    .ai-wizard-hint { color: var(--text-secondary); font-size: 0.8rem; }

    .ai-provider-select {
      h3 {
        margin: 0 0 var(--ui-spacing-xs) 0;
        font-size: var(--ui-font-base);
        font-weight: $font-weight-semibold;
        color: var(--text-primary);
      }

      .field-description {
        margin: 0 0 var(--ui-spacing-md) 0;
      }
    }

    .provider-cards {
      display: flex;
      gap: var(--ui-spacing-md);
    }

    .provider-card {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--ui-spacing-xs);
      padding: var(--ui-spacing-lg);
      background: var(--bg-surface);
      border: 2px solid var(--border-subtle);
      border-radius: $radius-lg;
      cursor: pointer;
      transition: all $duration-fast $ease-out;

      &:hover {
        background: var(--bg-hover);
        border-color: var(--border-default);
      }

      &.selected {
        border-color: var(--accent);
        background: color-mix(in srgb, var(--accent) 15%, transparent);
      }
    }

    .provider-icon {
      font-size: 2rem;
    }

    .provider-name {
      font-size: var(--ui-font-base);
      font-weight: $font-weight-semibold;
      color: var(--text-primary);
    }

    .provider-desc {
      font-size: var(--ui-font-xs);
      color: var(--text-tertiary);
    }

    .provider-status {
      font-size: var(--ui-font-xs);
      padding: 2px 8px;
      border-radius: 4px;
      margin-top: var(--ui-spacing-xs);

      &.available {
        background: var(--success-bg);
        color: var(--success);
      }

      &.unavailable {
        background: var(--error-bg);
        color: var(--error);
      }
    }

    .provider-settings {
      background: var(--bg-surface);
      border-radius: $radius-md;
      padding: var(--ui-spacing-lg);
    }

    .settings-group {
      h4 {
        margin: 0 0 var(--ui-spacing-lg) 0;
        font-size: var(--ui-font-base);
        font-weight: $font-weight-semibold;
        color: var(--text-primary);
      }
    }

    .api-key-input {
      width: 280px;
      font-family: monospace;
    }

    .no-models-hint {
      font-size: var(--ui-font-sm);
      color: var(--text-tertiary);
      font-style: italic;
    }

    .api-key-hint {
      margin-top: var(--ui-spacing-md);
      font-size: var(--ui-font-sm);
      color: var(--text-tertiary);

      a {
        color: var(--accent);
        text-decoration: none;

        &:hover {
          text-decoration: underline;
        }
      }
    }

    .connection-status {
      margin-top: var(--ui-spacing-md);
      padding: var(--ui-spacing-sm) var(--ui-spacing-md);
      border-radius: $radius-md;
      font-size: var(--ui-font-sm);

      &.success {
        background: var(--success-bg);
        color: var(--success);
      }

      &.error {
        background: var(--error-bg);
        color: var(--error);
      }

      .models-available {
        opacity: 0.8;
        margin-left: var(--ui-spacing-xs);
      }
    }

    // Bookshelf Server Section Styles
    .bookshelf-section {
      display: flex;
      flex-direction: column;
      gap: var(--ui-spacing-xl);
    }

    .server-status-card {
      background: var(--bg-surface);
      border-radius: $radius-md;
      padding: var(--ui-spacing-lg);
      border: 2px solid var(--border-subtle);
      transition: border-color $duration-fast $ease-out;

      &.running {
        border-color: var(--success);
      }
    }

    .status-indicator {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-sm);
      margin-bottom: var(--ui-spacing-md);
    }

    .status-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--error);

      .server-status-card.running & {
        background: var(--success);
        animation: pulse 2s infinite;
      }
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    .status-text {
      font-size: var(--ui-font-base);
      font-weight: $font-weight-semibold;
      color: var(--text-primary);
    }

    .server-addresses {
      h4 {
        margin: 0 0 var(--ui-spacing-sm) 0;
        font-size: var(--ui-font-sm);
        font-weight: $font-weight-medium;
        color: var(--text-secondary);
      }
    }

    .server-address {
      display: block;
      padding: var(--ui-spacing-xs) var(--ui-spacing-sm);
      margin-bottom: var(--ui-spacing-xs);
      background: var(--bg-elevated);
      border-radius: $radius-sm;
      color: var(--accent);
      font-family: monospace;
      font-size: var(--ui-font-sm);
      text-decoration: none;
      transition: background $duration-fast $ease-out;

      &:hover {
        background: var(--bg-hover);
        text-decoration: underline;
      }
    }

    .server-controls {
      display: flex;
      gap: var(--ui-spacing-md);
    }

    .help-text {
      padding: var(--ui-spacing-md);
      background: var(--bg-surface);
      border-radius: $radius-md;
      font-size: var(--ui-font-sm);
      color: var(--text-tertiary);

      p {
        margin: 0;
        line-height: 1.5;
      }
    }

    // Tools Section Styles
    .tools-section {
      display: flex;
      flex-direction: column;
      gap: var(--ui-spacing-lg);
    }

    .addons-hub {
      display: flex;
      flex-direction: column;
      gap: var(--ui-spacing-xl, 32px);
    }

    .addons-group-title {
      margin: 0 0 4px;
      font-size: 15px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .addons-group-sub {
      margin: 0 0 var(--ui-spacing-md, 12px);
      font-size: 13px;
      color: var(--text-secondary);
    }

    .tool-row {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--ui-spacing-xl);
      padding: var(--ui-spacing-lg);
      background: var(--bg-surface);
      border-radius: $radius-md;
    }

    .tool-info {
      flex: 1;
      min-width: 0;

      h4 {
        margin: 0 0 var(--ui-spacing-xs) 0;
        font-size: var(--ui-font-base);
        font-weight: $font-weight-semibold;
        color: var(--text-primary);
      }

      .tool-description {
        margin: 0 0 var(--ui-spacing-sm) 0;
        font-size: var(--ui-font-sm);
        color: var(--text-tertiary);
      }
    }

    .tool-status {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-sm);
      font-size: var(--ui-font-sm);
    }

    .status-badge {
      padding: 2px 8px;
      border-radius: 4px;
      font-size: var(--ui-font-xs);
      font-weight: $font-weight-medium;

      &.configured {
        background: color-mix(in srgb, var(--accent) 15%, transparent);
        color: var(--accent);
      }

      &.detected {
        background: var(--success-bg);
        color: var(--success);
      }

      &.not-found {
        background: var(--error-bg);
        color: var(--error);
      }
    }

    .tool-path {
      color: var(--text-secondary);
      font-family: monospace;
      font-size: var(--ui-font-xs);
      word-break: break-all;
    }

    .tool-control {
      flex-shrink: 0;
      min-width: 320px;
    }

    .loading-hint {
      color: var(--text-tertiary);
      font-style: italic;
    }

    /* WSL2 Section Styles */
    .wsl-section {
      margin-top: var(--ui-spacing-xl);
      padding-top: var(--ui-spacing-xl);
      border-top: 1px solid var(--border);
    }

    .wsl-section-title {
      margin: 0 0 var(--ui-spacing-sm) 0;
      font-size: var(--ui-font-base);
      font-weight: $font-weight-semibold;
      color: var(--text-primary);
    }

    .wsl-description {
      margin: 0 0 var(--ui-spacing-lg) 0;
      font-size: var(--ui-font-sm);
      color: var(--text-tertiary);
    }

    .wsl-status {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-sm);
      margin-bottom: var(--ui-spacing-lg);

      &.not-available {
        flex-direction: column;
        align-items: flex-start;
      }

      .wsl-version {
        font-size: var(--ui-font-xs);
        color: var(--text-tertiary);
      }

      .wsl-help {
        margin: var(--ui-spacing-sm) 0 0 0;
        font-size: var(--ui-font-sm);
        color: var(--text-tertiary);

        code {
          background: var(--bg-surface);
          padding: 2px 6px;
          border-radius: 4px;
          font-family: monospace;
        }
      }
    }

    .wsl-loading {
      color: var(--text-tertiary);
      font-style: italic;
    }

    .wsl-verify-section {
      margin-top: var(--ui-spacing-lg);
      padding: var(--ui-spacing-lg);
      background: var(--bg-surface);
      border-radius: $radius-md;
    }

    .wsl-setup-status {
      margin-top: var(--ui-spacing-md);
      padding: var(--ui-spacing-md);
      border-radius: $radius-sm;

      &.valid {
        background: var(--success-bg);
        color: var(--success);
      }

      &.invalid {
        background: var(--error-bg);
        color: var(--error);
      }

      .status-icon {
        font-size: var(--ui-font-lg);
        margin-right: var(--ui-spacing-sm);
      }

      .setup-checklist {
        display: flex;
        gap: var(--ui-spacing-md);
        margin-top: var(--ui-spacing-sm);

        .found {
          color: var(--success);
        }

        .not-found {
          color: var(--error);
        }
      }

      .setup-errors {
        margin-top: var(--ui-spacing-sm);

        .error-text {
          margin: var(--ui-spacing-xs) 0 0 0;
          font-size: var(--ui-font-xs);
        }
      }
    }

    .toggle-input {
      width: 40px;
      height: 20px;
      cursor: pointer;
    }

  `]
})
export class SettingsComponent implements OnInit {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly settingsService = inject(SettingsService);
  private readonly pluginService = inject(PluginService);
  private readonly electronService = inject(ElectronService);
  private readonly libraryService = inject(LibraryService);
  private readonly componentService = inject(ComponentService);

  readonly selectedSection = signal('library');

  /*
   * `gpuPackInstalled` and `setStreamDevice` ARE GONE (2026-09-14, audit
   * section 3.7). They were the reader and the writer for "Generation Device",
   * and the writer wrote to an explicit no-op: the ONLY implementation of
   * `setStreamWorkerConfig` (orpheus-worker-pool.ts) does nothing and
   * `getStreamWorkerConfig()` answers a hardcoded `devicePref: 'auto'`. The
   * venue is the device choice now — GPU IS ONE GLOBAL CHOICE — and a render's
   * card belongs to whichever server the venue named.
   */

  /*
   * THE STREAMING VOICE AND ENGINE PICKERS ARE GONE FROM SETTINGS (Phase 16
   * step 8, 2026-09-15). `setStreamEngine`, `setStreamVoice`, `voiceOptions`,
   * `streamEngineBlurb`, `streamEngineInfo`, `streamEngineError` and
   * `HIGGS_STREAM_GROUP` all existed for the "TTS Server" section, which served
   * one external client: the browser extension. That client picks its own
   * server and its own voice now, from that server's `GET /v1/voices`
   * (docs/EXTENSION-TO-CRUCIBLE-PLAN.md section 0), so a BookForge-side picker
   * for it would be a second owner of one fact, and the stale one.
   *
   * The engine BookForge ITSELF streams with is still chosen — on the Streaming
   * tab, which is the surface that uses it (`live-tts.component.ts` binds the
   * same WorkerConfigService). One control, on the page that acts on it.
   */

  // Library section state
  readonly savedLibraryPath = computed(() => this.libraryService.libraryPath() || '~/Documents/BookForge');
  // Draft path chosen via Browse but not yet applied (null = in sync with saved)
  readonly libraryDraftPath = signal<string | null>(null);
  readonly currentLibraryPath = computed(() => this.libraryDraftPath() ?? this.savedLibraryPath());
  readonly libraryDirty = computed(() => {
    const draft = this.libraryDraftPath();
    return draft !== null && draft !== this.savedLibraryPath();
  });
  readonly librarySaving = signal(false);
  readonly libraryChangeStatus = signal<{ success: boolean; message: string } | null>(null);

  // Storage section state
  readonly totalCacheSize = signal(0);
  readonly cacheLoading = signal(false);
  readonly clearCacheStatus = signal<{ success: boolean; message: string } | null>(null);

  // Bookshelf Server section state — edits buffered in bookshelfDraft until Save.
  readonly savedBookshelfConfig = computed(() => this.settingsService.getBookshelfConfig());
  readonly bookshelfDraft = signal<{ port?: number } | null>(null);
  readonly bookshelfConfig = computed(() => {
    const saved = this.savedBookshelfConfig();
    const draft = this.bookshelfDraft();
    return draft ? { ...saved, ...draft } : saved;
  });
  readonly bookshelfDirty = computed(() => {
    const draft = this.bookshelfDraft();
    if (!draft) return false;
    const saved = this.savedBookshelfConfig();
    return JSON.stringify({ ...saved, ...draft }) !== JSON.stringify(saved);
  });
  readonly bookshelfStatus = signal<{ running: boolean; port: number; addresses: string[] } | null>(null);
  readonly bookshelfLoading = signal(false);
  readonly bookshelfSaving = signal(false);
  readonly bookshelfError = signal<string | null>(null);

  // Tab Recorder section state. Port/host/token live main-process side in the
  // server's config; edits buffer in a draft until Save.
  readonly tabRecordStatus = signal<{ running: boolean; port: number; host: string; token: string; addresses: string[] } | null>(null);
  readonly tabRecordDraft = signal<{ port?: number; host?: string } | null>(null);
  readonly tabRecordSaving = signal(false);
  readonly tabRecordError = signal<string | null>(null);
  readonly tabRecordTokenVisible = signal(false);
  readonly tabRecordCopied = signal(false);
  private tabRecordCopiedTimer: ReturnType<typeof setTimeout> | null = null;
  // Effective port/host shown in the form (draft overlay over server status)
  readonly tabRecordViewPort = computed(() => this.tabRecordDraft()?.port ?? this.tabRecordStatus()?.port ?? 8766);
  readonly tabRecordViewHost = computed(() => this.tabRecordDraft()?.host ?? this.tabRecordStatus()?.host ?? '127.0.0.1');

  // Dirty flag for the Tab Recorder section's Save button (port/host only)
  readonly tabRecordDirty = computed(() => {
    const status = this.tabRecordStatus();
    const draft = this.tabRecordDraft();
    return !!draft && (
      (draft.port !== undefined && draft.port !== status?.port) ||
      (draft.host !== undefined && draft.host !== status?.host)
    );
  });

  // Tools section state. toolPathsConfig is the saved config; pending edits go
  // into toolPathsDraft (keyed overrides) and only persist on Save.
  // The SAVED config carries real booleans for the checkbox keys — `updateConfig`
  // (electron/tool-paths.ts, BOOLEAN_CONFIG_KEYS) coerces the renderer's 'true'
  // at the IPC boundary so every main-process reader can ask `=== true`. The
  // DRAFT is this component's own strings. Both shapes are named here rather
  // than typed as string and lied about: reading a saved boolean back as a
  // string is what made a saved toggle come back unchecked (Owen, 2026-09-08).
  readonly toolPathsConfig = signal<Record<string, string | boolean | undefined>>({});
  // The DRAFT is only ever this component's own strings (updateToolPath writes
  // 'true' / '' for a checkbox), and it is what goes over IPC on save.
  readonly toolPathsDraft = signal<Record<string, string | undefined>>({});
  readonly toolPathsStatus = signal<Record<string, { configured: boolean; detected: boolean; path: string }>>({});
  readonly toolPathsLoading = signal(false);
  readonly toolPathsSaving = signal(false);
  readonly toolPathsSaveStatus = signal<{ success: boolean; message: string } | null>(null);
  // Packaged builds run on the bundled relocatable env and never need conda, so
  // the Conda tool row is hidden there. It stays visible in dev / BYO setups.
  readonly usingBundledEnv = signal(false);
  readonly toolPathsDirty = computed(() => {
    const draft = this.toolPathsDraft();
    const saved = this.toolPathsConfig();
    // Through the normaliser on BOTH sides: a checkbox's draft is the string
    // 'true' and its saved value is the boolean true, and comparing those raw
    // left the row permanently dirty (Save never went back to "Saved").
    return Object.keys(draft).some(k => toolPathText(draft[k]) !== toolPathText(saved[k]));
  });

  // WSL2 state (Windows only, for Orpheus TTS)
  readonly wslAvailable = signal<{
    available: boolean;
    version?: number;
    distros: string[];
    defaultDistro?: string;
  } | null>(null);
  readonly wslSetupStatus = signal<{
    valid: boolean;
    condaFound: boolean;
    sessionsRootFound: boolean;
    orpheusEnvFound: boolean;
    errors: string[];
  } | null>(null);
  readonly wslVerifying = signal(false);
  readonly wslSaving = signal(false);
  readonly isWindows = signal(typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('win'));
  // Parallel streaming workers only help on macOS (CPU/MPS). On CUDA/NVIDIA the engine
  // serializes to 1 worker — extra workers just contend for the GPU — so the
  // setting is hidden off-Mac.
  readonly isMac = signal(typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac'));

  /*
   * The Orpheus batch-size reader and its two writers are GONE with the control
   * (2026-09-14, audit section 3.7). Its only consumer is the legacy WSL
   * Orpheus spawn; on a Crucible the render width is HIGGS_MAX_NUM_SEQS in the
   * SERVER's own config, which is the DIVISION OF KNOWLEDGE ruling — tuning is
   * Crucible config, never a client's control. `<userData>/orpheus-batch.json`
   * and `electron/orpheus-batch.ts` are untouched and die with that layer.
   */

  // Combine built-in and plugin sections
  readonly allSections = computed(() => {
    return this.settingsService.sections();
  });

  // Get current section
  readonly currentSection = computed(() => {
    return this.allSections().find(s => s.id === this.selectedSection());
  });

  ngOnInit(): void {
    // Deep-link: `?section=<id>` preselects one of the eleven sections — used
    // by the translation-step language gate and by refusals that send somebody
    // to a specific page ("Update foundry in Settings → General add-ons"). The
    // guard below is what makes a stale link harmless: an id no section
    // answers to leaves the default selected rather than drawing an empty page.
    // (It used to read `?section=xtts`, naming a section this app has not had
    // since XTTS was retired.)
    const section = this.route.snapshot.queryParamMap.get('section');
    if (section && this.allSections().some(s => s.id === section)) {
      this.selectedSection.set(section);
    }
    // Load cache size on init
    this.refreshCacheSize();
    // Check bookshelf server status
    this.refreshBookshelfStatus();
    // Check tab-record server status
    this.refreshTabRecordStatus();
    // Load tool paths
    this.refreshToolPaths();
    // Detect WSL on Windows
    if (this.isWindows()) {
      this.detectWsl();
    }
  }

  goBack(): void {
    this.router.navigate(['/studio']);
  }

  openAiSetup(): void {
    this.router.navigate(['/ai-setup']);
  }

  /** Reopen the guided first-run walkthrough (Settings → General). */
  openGuidedSetup(): void {
    this.router.navigate(['/setup']);
  }

  selectSection(sectionId: string): void {
    this.selectedSection.set(sectionId);
  }

  /**
   * THE THREE TOOLS BOOKFORGE STILL INSTALLS, and it is a literal list again
   * (2026-09-14, audit section 3.12).
   *
   * foundry FIRST: it is the engine every document pass and every Clean text
   * run spawns, its refusals send the user to this page ("Update foundry in
   * Settings → General add-ons"), and until 2026-09-07 no page listed it at
   * all — the startup check found 1.2.0, the queue refused 1.0.2 by name, and
   * there was no row anywhere to press Update on. Then Calibre and Tesseract,
   * two CPU tools with nothing to do with a card.
   *
   * TWO ENTRIES WERE DELETED, and the reason differs:
   *
   * - `llama-cuda` is the CUDA pack for the BUNDLED llama.cpp, whose only
   *   purpose is the local text engine the ONE legacy switch covers. It is a
   *   DELETE-AFTER-PASS row and the door to it goes now: an `llm` model is a
   *   Crucible subject, and a second local llama.cpp is the second copy that
   *   rollout ruling 1 forbids.
   * - the `kind === 'blocks-model'` FILTER was a filter over an empty set. No
   *   catalog entry declares that kind anywhere in the repo, so the derived
   *   list it justified has always been `[]` and the page-layout model it
   *   described is installable from nowhere. A computed that can only ever add
   *   nothing is not a generalisation, it is a claim that something is
   *   installable when it is not — so the list is a literal again, honestly.
   */
  readonly generalAddOnIds = ['foundry-cli', 'calibre', 'tesseract'];

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
      this.settingsService.setPending(`${pluginId}.${field.key}`, value);
    } else {
      this.settingsService.setPending(field.key, value);
    }
  }

  /** Map a SettingField's option list to desktop-select options. */
  toSelectOptions(opts?: { value: string; label: string }[]): DesktopSelectItems {
    return (opts ?? []).map((o) => ({ value: o.value, label: o.label }));
  }

  /** Build WSL distro options, mirroring the old "(default)" label suffix. */
  wslDistroOptions(distros: string[], defaultDistro?: string): DesktopSelectItems {
    return (distros ?? []).map((d) => ({
      value: d,
      label: d + (d === defaultDistro ? ' (default)' : ''),
    }));
  }

  async saveSettings(): Promise<void> {
    await this.settingsService.savePendingChanges();

    // Update plugin settings if any plugin settings were changed
    const section = this.currentSection();
    if (section?.isPlugin) {
      const pluginId = section.id.replace('plugin-', '');
      this.updatePluginSettings(pluginId);
    }
  }

  hasUnsavedChanges(): boolean {
    return this.settingsService.hasUnsavedChanges();
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

  // ── Protect professionally-read audiobooks: output/ → archive/ migration ──
  readonly archiveMigrating = signal(false);
  readonly archiveMigrationResult = signal<{
    success: boolean;
    migrated: number;
    skipped: number;
    failed: number;
    books: Array<{ projectId: string; title: string; status: 'migrated' | 'skipped' | 'failed'; reason?: string; orphans?: string[] }>;
  } | null>(null);

  async migrateAudiobooksToArchive(): Promise<void> {
    this.archiveMigrating.set(true);
    this.archiveMigrationResult.set(null);
    try {
      const api = (window as any).electron?.library?.migrateAudiobooksToArchive;
      if (!api) throw new Error('This build does not expose the archive migration.');
      const result = await api();
      this.archiveMigrationResult.set(result);
    } catch (err) {
      this.archiveMigrationResult.set({
        success: false, migrated: 0, skipped: 0, failed: 0,
        books: [{ projectId: '', title: 'Migration failed', status: 'failed', reason: (err as Error).message }],
      });
    } finally {
      this.archiveMigrating.set(false);
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

  async browseForFolder(field: SettingField): Promise<void> {
    const result = await this.electronService.openFolderDialog();
    if (result.success && result.folderPath) {
      this.setFieldValue(field, result.folderPath);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Library Configuration Methods
  // ─────────────────────────────────────────────────────────────────────────────

  async browseForLibraryFolder(): Promise<void> {
    const result = await this.electronService.openFolderDialog();
    if (result.success && result.folderPath) {
      // Stage the choice as a draft; nothing changes until the user clicks Save.
      this.libraryChangeStatus.set(null);
      this.libraryDraftPath.set(result.folderPath);
    }
  }

  async saveLibrary(): Promise<void> {
    const newPath = this.libraryDraftPath();
    if (newPath === null || !this.libraryDirty()) return;

    this.librarySaving.set(true);
    this.libraryChangeStatus.set(null);
    try {
      const setResult = await this.libraryService.setLibraryPath(newPath);
      if (setResult.success) {
        this.libraryDraftPath.set(null);
        this.libraryChangeStatus.set({
          success: true,
          message: `Library location updated to: ${newPath}`
        });
        setTimeout(() => this.libraryChangeStatus.set(null), 5000);
      } else {
        this.libraryChangeStatus.set({
          success: false,
          message: setResult.error || 'Failed to update library location'
        });
      }
    } catch (err) {
      this.libraryChangeStatus.set({
        success: false,
        message: err instanceof Error ? err.message : 'Failed to update library location'
      });
    } finally {
      this.librarySaving.set(false);
    }
  }

  discardLibrary(): void {
    this.libraryDraftPath.set(null);
    this.libraryChangeStatus.set(null);
  }


  // ─────────────────────────────────────────────────────────────────────────────
  // Bookshelf Server Methods
  // ─────────────────────────────────────────────────────────────────────────────

  async refreshBookshelfStatus(): Promise<void> {
    try {
      const result = await this.electronService.bookshelfGetStatus();
      if (result.success && result.data) {
        this.bookshelfStatus.set(result.data);
      }
    } catch (err) {
      console.error('Failed to get bookshelf server status:', err);
    }
  }

  async startBookshelf(): Promise<void> {
    const config = this.savedBookshelfConfig();

    this.bookshelfLoading.set(true);
    this.bookshelfError.set(null);

    try {
      const result = await this.electronService.bookshelfStart({
        port: config.port,
      });

      if (result.success && result.data) {
        this.bookshelfStatus.set(result.data);
        // Nothing is written down about "running": `bookshelfConfig.enabled`
        // was read by nobody but the settings UI itself (audit section 3.6) and
        // is deleted. The server's status is the server's, read back with
        // `bookshelfStatus()`.
      } else {
        this.bookshelfError.set(result.error || 'Failed to start server');
      }
    } catch (err) {
      this.bookshelfError.set(err instanceof Error ? err.message : 'Failed to start server');
    } finally {
      this.bookshelfLoading.set(false);
    }
  }

  async stopBookshelf(): Promise<void> {
    this.bookshelfLoading.set(true);
    this.bookshelfError.set(null);

    try {
      const result = await this.electronService.bookshelfStop();
      if (result.success) {
        this.bookshelfStatus.set({ running: false, port: 0, addresses: [] });
      } else {
        this.bookshelfError.set(result.error || 'Failed to stop server');
      }
    } catch (err) {
      this.bookshelfError.set(err instanceof Error ? err.message : 'Failed to stop server');
    } finally {
      this.bookshelfLoading.set(false);
    }
  }

  /** Stage a bookshelf field edit into the draft (persists on Save). */
  private patchBookshelfDraft(updates: { port?: number }): void {
    this.bookshelfDraft.set({ ...(this.bookshelfDraft() ?? {}), ...updates });
  }

  updateBookshelfPort(port: number): void {
    if (port >= 1 && port <= 65535) {
      this.patchBookshelfDraft({ port });
    }
  }

  async saveBookshelf(): Promise<void> {
    const draft = this.bookshelfDraft();
    if (!draft || !this.bookshelfDirty()) return;

    this.bookshelfSaving.set(true);
    this.bookshelfError.set(null);
    try {
      const portChanged = draft.port !== undefined && draft.port !== this.savedBookshelfConfig().port;
      this.settingsService.updateBookshelfConfig(draft);
      this.bookshelfDraft.set(null);
      // A port change only takes effect on restart; do it if the server is up
      if (portChanged && this.bookshelfStatus()?.running) {
        await this.restartBookshelf();
      }
    } catch (err) {
      this.bookshelfError.set(err instanceof Error ? err.message : 'Failed to save bookshelf settings');
    } finally {
      this.bookshelfSaving.set(false);
    }
  }

  discardBookshelf(): void {
    this.bookshelfDraft.set(null);
    this.bookshelfError.set(null);
  }

  private async restartBookshelf(): Promise<void> {
    const config = this.savedBookshelfConfig();

    this.bookshelfLoading.set(true);
    this.bookshelfError.set(null);

    try {
      if (this.bookshelfStatus()?.running) {
        await this.electronService.bookshelfStop();
      }

      const result = await this.electronService.bookshelfStart({
        port: config.port,
      });

      if (result.success && result.data) {
        this.bookshelfStatus.set(result.data);
        // Nothing is written down about "running": `bookshelfConfig.enabled`
        // was read by nobody but the settings UI itself (audit section 3.6) and
        // is deleted. The server's status is the server's, read back with
        // `bookshelfStatus()`.
      } else {
        this.bookshelfError.set(result.error || 'Failed to start server');
      }
    } catch (err) {
      this.bookshelfError.set(err instanceof Error ? err.message : 'Failed to start server');
    } finally {
      this.bookshelfLoading.set(false);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Tab Recorder Methods
  // ─────────────────────────────────────────────────────────────────────────────

  async refreshTabRecordStatus(): Promise<void> {
    try {
      const result = await this.electronService.tabRecordStatus();
      if (result.success && result.data) {
        this.tabRecordStatus.set(result.data);
      }
    } catch (err) {
      console.error('Failed to get tab-record server status:', err);
    }
  }

  updateTabRecordPort(port: number): void {
    if (port >= 1 && port <= 65535) {
      this.tabRecordDraft.set({ ...(this.tabRecordDraft() ?? {}), port });
    }
  }

  toggleTabRecordLan(enabled: boolean): void {
    this.tabRecordDraft.set({ ...(this.tabRecordDraft() ?? {}), host: enabled ? '0.0.0.0' : '127.0.0.1' });
  }

  /** Persist the recorder's address: restarts the WebSocket server. */
  async saveTabRecordServer(): Promise<void> {
    if (!this.tabRecordDirty()) return;
    this.tabRecordSaving.set(true);
    this.tabRecordError.set(null);

    try {
      const draft = this.tabRecordDraft();
      if (draft && (draft.port !== undefined || draft.host !== undefined)) {
        const result = await this.electronService.tabRecordConfigure(draft);
        if (result.success && result.data) {
          this.tabRecordStatus.set(result.data);
          this.tabRecordDraft.set(null);
        } else {
          this.tabRecordError.set(result.error || 'Failed to apply tab recorder settings');
          return;
        }
      }
    } catch (err) {
      this.tabRecordError.set(err instanceof Error ? err.message : 'Failed to save tab recorder settings');
    } finally {
      this.tabRecordSaving.set(false);
    }
  }

  discardTabRecordServer(): void {
    this.tabRecordDraft.set(null);
    this.tabRecordError.set(null);
  }

  copyTabRecordToken(): void {
    const token = this.tabRecordStatus()?.token;
    if (!token) return;
    navigator.clipboard.writeText(token);
    this.tabRecordCopied.set(true);
    if (this.tabRecordCopiedTimer) clearTimeout(this.tabRecordCopiedTimer);
    this.tabRecordCopiedTimer = setTimeout(() => this.tabRecordCopied.set(false), 2000);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool Paths Methods
  // ─────────────────────────────────────────────────────────────────────────────

  async refreshToolPaths(): Promise<void> {
    this.toolPathsLoading.set(true);
    try {
      // Load config
      const configResult = await this.electronService.toolPathsGetConfig();
      if (configResult.success && configResult.data) {
        this.toolPathsConfig.set(configResult.data);
      }

      // Load status
      const statusResult = await this.electronService.toolPathsGetStatus();
      if (statusResult.success && statusResult.data) {
        this.toolPathsStatus.set(statusResult.data);
      }

      // Whether conda is even relevant (hidden on packaged/bundled-env builds).
      const bundledResult = await this.electronService.runtimeUsingBundledEnv();
      if (bundledResult.success && bundledResult.data !== undefined) {
        this.usingBundledEnv.set(bundledResult.data);
      }
    } catch (err) {
      console.error('Failed to load tool paths:', err);
    } finally {
      this.toolPathsLoading.set(false);
    }
  }

  /** Stage a tool-path edit into the draft; persists on Save. */
  updateToolPath(key: string, value: string): void {
    this.toolPathsSaveStatus.set(null);
    this.toolPathsDraft.set({ ...this.toolPathsDraft(), [key]: value || undefined });
  }

  async browseForToolPath(key: string): Promise<void> {
    // For all paths, use folder dialog - user can then append executable name if needed
    const result = await this.electronService.openFolderDialog();

    if (result.success && result.folderPath) {
      // For executable paths, append the expected filename
      let finalPath = result.folderPath;
      const isWindows = navigator.platform.toLowerCase().includes('win');

      if (key === 'condaPath') {
        finalPath = isWindows
          ? `${result.folderPath}\\conda.exe`
          : `${result.folderPath}/conda`;
      } else if (key === 'ffmpegPath') {
        finalPath = isWindows
          ? `${result.folderPath}\\ffmpeg.exe`
          : `${result.folderPath}/ffmpeg`;
      }

      this.updateToolPath(key, finalPath);
    }
  }

  async saveTools(): Promise<void> {
    if (!this.toolPathsDirty()) return;
    this.toolPathsSaving.set(true);
    this.toolPathsSaveStatus.set(null);
    try {
      const result = await this.electronService.toolPathsUpdateConfig(this.toolPathsDraft());
      if (result.success && result.data) {
        this.toolPathsConfig.set(result.data);
        this.toolPathsDraft.set({});
        await this.refreshToolPaths();
        this.toolPathsSaveStatus.set({ success: true, message: 'Saved' });
        setTimeout(() => this.toolPathsSaveStatus.set(null), 2000);
      } else {
        this.toolPathsSaveStatus.set({ success: false, message: result.error || 'Failed to save' });
      }
    } catch (err) {
      this.toolPathsSaveStatus.set({
        success: false,
        message: err instanceof Error ? err.message : 'Failed to save'
      });
    } finally {
      this.toolPathsSaving.set(false);
    }
  }

  discardTools(): void {
    this.toolPathsDraft.set({});
    this.toolPathsSaveStatus.set(null);
  }

  getToolPathValue(key: string): string {
    const draft = this.toolPathsDraft();
    if (key in draft) return toolPathText(draft[key]);
    return toolPathText(this.toolPathsConfig()[key]);
  }

  /**
   * A tool-path CHECKBOX's state, which is NOT `getToolPathValue(key) ===
   * 'true'`.
   *
   * The draft holds this component's own string; the saved config holds a real
   * boolean, because `updateConfig` coerces at the IPC boundary so that every
   * main-process reader can ask `=== true` (electron/tool-paths.ts,
   * BOOLEAN_CONFIG_KEYS). Comparing the saved boolean to the string 'true' is
   * false, so a box that was saved ON came back UNCHECKED on the next visit —
   * Owen, 2026-09-08: "i checked the box, hit save, went back, its unchecked
   * now". The SETTING was on the whole time (his tool-paths.json had
   * `useWsl2ForHiggs: true` and Higgs was routing through WSL); only the box
   * lied. Both shapes are accepted here, at the one place that renders them.
   */
  getToolPathFlag(key: string): boolean {
    return this.getToolPathValue(key) === 'true';
  }

  getToolStatus(key: string): { configured: boolean; detected: boolean; path: string } | undefined {
    const status = this.toolPathsStatus();
    return status[key];
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // WSL2 Methods (Windows only, for Orpheus TTS)
  // ─────────────────────────────────────────────────────────────────────────────

  async detectWsl(): Promise<void> {
    if (!this.isWindows()) return;

    try {
      const result = await this.electronService.wslDetect();
      if (result.success && result.data) {
        this.wslAvailable.set(result.data);
      }
    } catch (err) {
      console.error('Failed to detect WSL:', err);
      this.wslAvailable.set(null);
    }
  }

  async verifyWslSetup(): Promise<void> {
    if (!this.isWindows()) return;

    this.wslVerifying.set(true);
    this.wslSetupStatus.set(null);

    try {
      // Verify against what's shown (draft overlay), not just the saved config
      const result = await this.electronService.wslCheckOrpheusSetup({
        distro: this.getToolPathValue('wslDistro') || undefined,
        condaPath: this.getToolPathValue('wslCondaPath') || undefined,
        sessionsRoot: this.getToolPathValue('wslSessionsRoot') || undefined,
      });

      if (result.success && result.data) {
        this.wslSetupStatus.set(result.data);
      }
    } catch (err) {
      console.error('Failed to verify WSL setup:', err);
      this.wslSetupStatus.set({
        valid: false,
        condaFound: false,
        sessionsRootFound: false,
        orpheusEnvFound: false,
        errors: [err instanceof Error ? err.message : 'Unknown error'],
      });
    } finally {
      this.wslVerifying.set(false);
    }
  }

  /** Route Higgs jobs through WSL. Separate from the Orpheus toggle on purpose:
   *  the two envs are independent, and folding them together would make enabling
   *  Orpheus silently promise a Higgs env that is not there. */
  toggleWsl2ForHiggs(enabled: boolean): void {
    this.updateToolPath('useWsl2ForHiggs', enabled ? 'true' : '');
  }

  toggleWsl2ForOrpheus(enabled: boolean): void {
    this.updateToolPath('useWsl2ForOrpheus', enabled ? 'true' : '');
  }

  /**
   * A SEPARATE toggle from the Orpheus one, not a second reader of it. A machine
   * can have a WSL env with vLLM for Orpheus and none for the page reader, or
   * the reverse — one flag standing for both would send a conversion at an env
   * that does not hold the model.
   */
  toggleWsl2ForVlm(enabled: boolean): void {
    this.updateToolPath('useWsl2ForVlm', enabled ? 'true' : '');
  }

  selectWslDistro(distro: string): void {
    this.updateToolPath('wslDistro', distro);
  }

  async saveWslSettings(): Promise<void> {
    this.wslSaving.set(true);
    try {
      // WSL fields are part of the tool-paths draft; commit them all
      await this.saveTools();
      setTimeout(() => this.wslSaving.set(false), 1500);
    } catch (err) {
      console.error('Failed to save WSL settings:', err);
      this.wslSaving.set(false);
    }
  }
}
