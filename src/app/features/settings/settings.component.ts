import { Component, inject, signal, computed, ChangeDetectionStrategy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, ActivatedRoute } from '@angular/router';
import { SettingsService, SettingsSection, SettingField } from '../../core/services/settings.service';
import { PluginService, PluginInfo } from '../../core/services/plugin.service';
import { ElectronService } from '../../core/services/electron.service';
import { LibraryService } from '../../core/services/library.service';
import { DesktopButtonComponent } from '../../creamsicle-desktop';
import { AddOnsPanelComponent } from './components/add-ons-panel.component';
import { VoicesPanelComponent } from './components/voices-panel.component';
import { LanguagesPanelComponent } from './components/languages-panel.component';
import { AiSetupWizardComponent } from '../ai-setup/ai-setup-wizard.component';
import { MultiWorkerToggleComponent } from '../../components/multi-worker-toggle/multi-worker-toggle.component';
import { WorkerConfigService } from '../../core/services/worker-config.service';
import { ComponentService } from '../../core/services/component.service';
import { PipelineDefaultsPanelComponent } from './components/pipeline-defaults-panel.component';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [CommonModule, FormsModule, DesktopButtonComponent, AddOnsPanelComponent, VoicesPanelComponent, LanguagesPanelComponent, AiSetupWizardComponent, MultiWorkerToggleComponent, PipelineDefaultsPanelComponent],
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

                <!-- Full uninstall of OUR data (keeps the user's library/books). -->
                <div class="storage-item">
                  <div class="storage-info">
                    <h3>Remove all BookForge data</h3>
                    <p>
                      Deletes everything BookForge downloaded — the audiobook engine, voice &amp; AI
                      models, language packs, GPU components, caches, and settings. <strong>Your
                      library and books are kept</strong> (they’re your files, not ours).
                      @if (isMac()) {
                        To finish uninstalling afterward, quit BookForge and drag it from Applications to the Trash.
                      } @else {
                        To finish uninstalling afterward, quit BookForge and run the Windows uninstaller.
                      }
                    </p>
                  </div>
                  <div class="storage-actions">
                    <desktop-button
                      variant="danger"
                      size="sm"
                      (click)="removeAllData()"
                      [disabled]="removingData()"
                    >
                      {{ removingData() ? 'Removing…' : 'Remove All Data' }}
                    </desktop-button>
                  </div>
                </div>
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

                  <!-- External Audiobooks Folder -->
                  <div class="field-row">
                    <div class="field-info">
                      <label class="field-label">External Audiobooks Folder</label>
                      <p class="field-description">M4B files placed here will appear on the bookshelf. Leave empty to disable.</p>
                    </div>
                    <div class="field-control">
                      <div class="path-input-group">
                        <input
                          type="text"
                          class="text-input path-input"
                          [value]="bookshelfConfig().externalAudiobooksDir || ''"
                          placeholder="/path/to/audiobooks"
                          (change)="updateExternalAudiobooksDir($any($event.target).value)"
                        />
                        <desktop-button variant="ghost" size="sm" (click)="browseExternalAudiobooksDir()">
                          Browse...
                        </desktop-button>
                      </div>
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
            } @else if (section.id === 'tts-api') {
              <!-- TTS API Server Section -->
              <div class="bookshelf-section">
                <!-- Server Status -->
                <div class="server-status-card" [class.running]="ttsApiStatus()?.running">
                  <div class="status-indicator">
                    <span class="status-dot"></span>
                    <span class="status-text">
                      {{ ttsApiStatus()?.running ? 'Running' : 'Stopped' }}
                    </span>
                  </div>
                  @if (ttsApiStatus()?.running) {
                    <div class="server-addresses">
                      <h4>WebSocket URLs</h4>
                      @for (address of ttsApiStatus()?.addresses || []; track address) {
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
                      <p class="field-description">Paste this into the browser extension. Every connection must present it.</p>
                    </div>
                    <div class="field-control">
                      <div class="path-input-group">
                        <input
                          type="text"
                          class="text-input token-input"
                          readonly
                          [value]="ttsApiTokenVisible() ? (ttsApiStatus()?.token || '') : '••••••••••••••••'"
                        />
                        <desktop-button variant="ghost" size="sm" (click)="ttsApiTokenVisible.set(!ttsApiTokenVisible())">
                          {{ ttsApiTokenVisible() ? 'Hide' : 'Show' }}
                        </desktop-button>
                        <desktop-button variant="ghost" size="sm" (click)="copyTtsApiToken()">
                          {{ ttsApiCopied() ? 'Copied!' : 'Copy' }}
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
                        [value]="ttsApiViewPort()"
                        min="1"
                        max="65535"
                        (change)="updateTtsApiPort(+$any($event.target).value)"
                        [disabled]="ttsApiSaving()"
                      />
                    </div>
                  </div>

                  <!-- LAN Access -->
                  <div class="field-row">
                    <div class="field-info">
                      <label class="field-label">Allow LAN Access</label>
                      <p class="field-description">Accept connections from other machines on your network. Off = this computer only.</p>
                    </div>
                    <div class="field-control">
                      <label class="toggle">
                        <input
                          type="checkbox"
                          [checked]="ttsApiViewHost() === '0.0.0.0'"
                          (change)="toggleTtsApiLan($any($event.target).checked)"
                          [disabled]="ttsApiSaving()"
                        />
                        <span class="toggle-slider"></span>
                      </label>
                    </div>
                  </div>
                </div>

                <!-- Generation device: CPU vs NVIDIA GPU for streaming playback.
                     GPU needs the downloadable CUDA pack (offered right here). -->
                <div class="settings-group">
                  <h4>Generation Device</h4>
                  <p class="field-description">
                    Where streaming playback generates audio. <strong>GPU</strong> (NVIDIA/CUDA)
                    is much faster but needs the GPU acceleration pack below; <strong>CPU</strong>
                    works everywhere and frees your VRAM. <strong>Auto</strong> uses the GPU when
                    it's available. Applies the next time the engine starts.
                  </p>
                  <div class="worker-options">
                    <button class="worker-btn" [class.selected]="workerCfg.devicePref() === 'auto'" (click)="setStreamDevice('auto')">Auto</button>
                    <button class="worker-btn" [class.selected]="workerCfg.devicePref() === 'cpu'" (click)="setStreamDevice('cpu')">CPU</button>
                    <button
                      class="worker-btn"
                      [class.selected]="workerCfg.devicePref() === 'gpu'"
                      [disabled]="!workerCfg.isCudaMachine()"
                      [title]="workerCfg.isCudaMachine() ? 'Generate on your NVIDIA GPU' : 'No NVIDIA GPU detected'"
                      (click)="setStreamDevice('gpu')"
                    >GPU</button>
                  </div>
                  @if (workerCfg.devicePref() === 'gpu' && !gpuPackInstalled()) {
                    <span class="hint warn-text">GPU selected, but the GPU acceleration pack isn't installed yet — download it below, then restart the engine.</span>
                  }

                  <!-- GPU acceleration download (CUDA PyTorch + llama), reused
                       from the Add-ons panel so it stays one implementation. -->
                  <app-add-ons-panel [onlyGpu]="true" />
                </div>

                <!-- Streaming Engine: multiple workers are a rare opt-in (only
                     help on shared-memory Apple Silicon). The toggle persists
                     itself and applies on the next engine start. -->
                <div class="settings-group">
                  <h4>Streaming Engine</h4>
                  <p class="field-description">
                    Worker count is shared by all streaming playback — the Listen
                    window, the browser extension, everything — and applies the next
                    time the engine starts.
                  </p>
                  <app-multi-worker-toggle />
                </div>

                <div class="save-section">
                  <desktop-button variant="primary" size="md" (click)="saveTtsServer()" [disabled]="!ttsServerDirty() || ttsApiSaving()">
                    {{ ttsApiSaving() ? 'Saving…' : (ttsServerDirty() ? 'Save Changes' : 'Saved') }}
                  </desktop-button>
                  @if (ttsServerDirty()) {
                    <desktop-button variant="ghost" size="md" (click)="discardTtsServer()" [disabled]="ttsApiSaving()">
                      Discard
                    </desktop-button>
                    <span class="unsaved-hint">Saving restarts the server</span>
                  }
                </div>

                @if (ttsApiError(); as error) {
                  <div class="status-message error">
                    {{ error }}
                  </div>
                }

                <!-- Help text -->
                <div class="help-text">
                  <p>
                    Lets external clients — like the BookForge browser extension — stream
                    text-to-speech from the TTS engine. Starts automatically with BookForge.
                    Protocol reference: docs/TTS_API.md in the repository.
                  </p>
                </div>
              </div>
            } @else if (section.id === 'tools') {
              <!-- Advanced Section (tool-path overrides, scratch dir, WSL) -->
              <div class="tools-section">
                @if (toolPathsLoading()) {
                  <p class="loading-hint">Loading tool paths...</p>
                }

                <!-- Conda Path — hidden on packaged builds (they run on the
                     bundled relocatable env and never need conda). Shown in
                     dev / bring-your-own setups. -->
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

                <!-- E2A Path -->
                <div class="tool-row">
                  <div class="tool-info">
                    <h4>ebook2audiobook</h4>
                    <p class="tool-description">TTS conversion engine installation folder</p>
                    @if (getToolStatus('e2a'); as status) {
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
                        [value]="getToolPathValue('e2aPath')"
                        placeholder="Auto-detect"
                        (change)="updateToolPath('e2aPath', $any($event.target).value)"
                      />
                      <desktop-button variant="ghost" size="sm" (click)="browseForToolPath('e2aPath')">
                        Browse...
                      </desktop-button>
                    </div>
                  </div>
                </div>

                <!-- WSL2 Settings (Windows only, for Orpheus TTS) -->
                @if (isWindows()) {
                  <div class="wsl-section">
                    <h3 class="wsl-section-title">WSL2 for Orpheus TTS</h3>
                    <p class="wsl-description">
                      Run Orpheus TTS in WSL2 for full CUDA graph performance (~6x faster than Windows native).
                    </p>

                    @if (wslAvailable(); as wsl) {
                      @if (wsl.available) {
                        <div class="wsl-status available">
                          <span class="status-badge detected">WSL2 Available</span>
                          <span class="wsl-version">WSL v{{ wsl.version || 2 }}</span>
                        </div>

                        <!-- Enable toggle -->
                        <div class="tool-row">
                          <div class="tool-info">
                            <h4>Enable WSL2 for Orpheus</h4>
                            <p class="tool-description">Use WSL2 to run Orpheus TTS with full CUDA graphs</p>
                          </div>
                          <div class="tool-control">
                            <input
                              type="checkbox"
                              class="toggle-input"
                              [checked]="getToolPathValue('useWsl2ForOrpheus') === 'true'"
                              (change)="toggleWsl2ForOrpheus($any($event.target).checked)"
                            />
                          </div>
                        </div>

                        <!-- WSL Distro -->
                        <div class="tool-row">
                          <div class="tool-info">
                            <h4>WSL Distribution</h4>
                            <p class="tool-description">Select the WSL distro with ebook2audiobook installed</p>
                          </div>
                          <div class="tool-control">
                            <select
                              class="text-input"
                              [value]="getToolPathValue('wslDistro') || wsl.defaultDistro || ''"
                              (change)="selectWslDistro($any($event.target).value)"
                            >
                              @for (distro of wsl.distros; track distro) {
                                <option [value]="distro">{{ distro }}{{ distro === wsl.defaultDistro ? ' (default)' : '' }}</option>
                              }
                            </select>
                          </div>
                        </div>

                        <!-- WSL Conda Path -->
                        <div class="tool-row">
                          <div class="tool-info">
                            <h4>WSL Conda Path</h4>
                            <p class="tool-description">Path to conda inside WSL (e.g., /home/user/miniconda3/bin/conda)</p>
                          </div>
                          <div class="tool-control">
                            <input
                              type="text"
                              class="text-input"
                              [value]="getToolPathValue('wslCondaPath')"
                              placeholder="/home/$USER/miniconda3/bin/conda"
                              (change)="updateToolPath('wslCondaPath', $any($event.target).value)"
                            />
                          </div>
                        </div>

                        <!-- WSL E2A Path -->
                        <div class="tool-row">
                          <div class="tool-info">
                            <h4>WSL ebook2audiobook Path</h4>
                            <p class="tool-description">Path to ebook2audiobook inside WSL</p>
                          </div>
                          <div class="tool-control">
                            <input
                              type="text"
                              class="text-input"
                              [value]="getToolPathValue('wslE2aPath')"
                              placeholder="/home/$USER/ebook2audiobook"
                              (change)="updateToolPath('wslE2aPath', $any($event.target).value)"
                            />
                          </div>
                        </div>

                        <!-- Save and Verify Buttons -->
                        <div class="wsl-verify-section">
                          <desktop-button
                            variant="primary"
                            size="sm"
                            (click)="saveWslSettings()"
                            [disabled]="wslSaving()"
                          >
                            {{ wslSaving() ? 'Saved!' : 'Save WSL Settings' }}
                          </desktop-button>
                          <desktop-button
                            variant="ghost"
                            size="sm"
                            (click)="verifyWslSetup()"
                            [disabled]="wslVerifying()"
                          >
                            {{ wslVerifying() ? 'Verifying...' : 'Verify WSL Setup' }}
                          </desktop-button>

                          @if (wslSetupStatus(); as setup) {
                            <div class="wsl-setup-status" [class.valid]="setup.valid" [class.invalid]="!setup.valid">
                              @if (setup.valid) {
                                <span class="status-icon">&#10003;</span>
                                <span>WSL setup verified - ready for Orpheus TTS</span>
                              } @else {
                                <span class="status-icon">&#10007;</span>
                                <div class="setup-checklist">
                                  <div [class.found]="setup.condaFound" [class.not-found]="!setup.condaFound">
                                    {{ setup.condaFound ? '✓' : '✗' }} Conda
                                  </div>
                                  <div [class.found]="setup.e2aFound" [class.not-found]="!setup.e2aFound">
                                    {{ setup.e2aFound ? '✓' : '✗' }} ebook2audiobook
                                  </div>
                                  <div [class.found]="setup.orpheusEnvFound" [class.not-found]="!setup.orpheusEnvFound">
                                    {{ setup.orpheusEnvFound ? '✓' : '✗' }} orpheus_tts conda env
                                  </div>
                                </div>
                                @if (setup.errors.length > 0) {
                                  <div class="setup-errors">
                                    @for (error of setup.errors; track error) {
                                      <p class="error-text">{{ error }}</p>
                                    }
                                  </div>
                                }
                              }
                            </div>
                          }
                        </div>
                      } @else {
                        <div class="wsl-status not-available">
                          <span class="status-badge not-found">WSL2 Not Available</span>
                          <p class="wsl-help">
                            To use WSL2 for Orpheus TTS, install WSL using: <code>wsl --install</code>
                          </p>
                        </div>
                      }
                    } @else {
                      <div class="wsl-loading">
                        <span>Detecting WSL...</span>
                      </div>
                    }
                  </div>
                }

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
              <!-- Add-ons & Models hub: optional tools/runtimes + downloadable
                   voices, merged into one section (WS7). -->
              <div class="addons-hub">
                <div class="addons-group">
                  <h3 class="addons-group-title">Tools &amp; Runtimes</h3>
                  <p class="addons-group-sub">Optional components: Calibre, Tesseract, Orpheus.</p>
                  <app-add-ons-panel></app-add-ons-panel>
                </div>
                <div class="addons-group">
                  <h3 class="addons-group-title">Voices</h3>
                  <p class="addons-group-sub">Download premium TTS voices, or add your own.</p>
                  <app-voices-panel></app-voices-panel>
                </div>
              </div>
            } @else if (section.id === 'languages') {
              <!-- Languages: downloadable Stanza sentence-segmentation packs
                   for cleanup & translation. -->
              <app-languages-panel></app-languages-panel>
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
    }
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
  protected readonly workerCfg = inject(WorkerConfigService);
  private readonly componentService = inject(ComponentService);

  readonly selectedSection = signal('library');

  /** True once the GPU acceleration pack (CUDA PyTorch) is installed. */
  readonly gpuPackInstalled = computed(() => this.componentService.isInstalled('cuda-tts'));

  /** Set the streaming engine's device preference (applies on next engine start). */
  setStreamDevice(pref: 'auto' | 'cpu' | 'gpu'): void {
    void this.workerCfg.setDevicePref(pref);
  }

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
  readonly removingData = signal(false);

  // Bookshelf Server section state — edits buffered in bookshelfDraft until Save.
  readonly savedBookshelfConfig = computed(() => this.settingsService.getBookshelfConfig());
  readonly bookshelfDraft = signal<{ port?: number; externalAudiobooksDir?: string } | null>(null);
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

  // TTS Server section state. Port/host live main-process side in tts-api.json;
  // worker count in tts-stream.json. Edits buffer in drafts until Save.
  readonly ttsApiStatus = signal<{ running: boolean; port: number; host: string; token: string; addresses: string[] } | null>(null);
  readonly ttsApiDraft = signal<{ port?: number; host?: string } | null>(null);
  readonly ttsApiSaving = signal(false);
  readonly ttsApiError = signal<string | null>(null);
  readonly ttsApiTokenVisible = signal(false);
  readonly ttsApiCopied = signal(false);
  private ttsApiCopiedTimer: ReturnType<typeof setTimeout> | null = null;
  // Effective port/host shown in the form (draft overlay over server status)
  readonly ttsApiViewPort = computed(() => this.ttsApiDraft()?.port ?? this.ttsApiStatus()?.port ?? 8766);
  readonly ttsApiViewHost = computed(() => this.ttsApiDraft()?.host ?? this.ttsApiStatus()?.host ?? '127.0.0.1');

  // The worker count is owned by <app-multi-worker-toggle> (WorkerConfigService),
  // which persists itself immediately — so it's not part of this section's Save.

  // Dirty flag for the TTS Server section's Save button (port/host only)
  readonly ttsServerDirty = computed(() => {
    const status = this.ttsApiStatus();
    const apiDraft = this.ttsApiDraft();
    return !!apiDraft && (
      (apiDraft.port !== undefined && apiDraft.port !== status?.port) ||
      (apiDraft.host !== undefined && apiDraft.host !== status?.host)
    );
  });

  // Tools section state. toolPathsConfig is the saved config; pending edits go
  // into toolPathsDraft (keyed overrides) and only persist on Save.
  readonly toolPathsConfig = signal<Record<string, string | undefined>>({});
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
    return Object.keys(draft).some(k => (draft[k] || '') !== (saved[k] || ''));
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
    e2aFound: boolean;
    orpheusEnvFound: boolean;
    errors: string[];
  } | null>(null);
  readonly wslVerifying = signal(false);
  readonly wslSaving = signal(false);
  readonly isWindows = signal(typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('win'));
  // Parallel XTTS workers only help on macOS (CPU/MPS). On CUDA/NVIDIA the engine
  // serializes to 1 worker — extra workers just contend for the GPU — so the
  // setting is hidden off-Mac.
  readonly isMac = signal(typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac'));

  // Combine built-in and plugin sections
  readonly allSections = computed(() => {
    return this.settingsService.sections();
  });

  // Get current section
  readonly currentSection = computed(() => {
    return this.allSections().find(s => s.id === this.selectedSection());
  });

  ngOnInit(): void {
    // Deep-link: ?section=languages preselects a section (used by the
    // translation-step language gate and first-run setup).
    const section = this.route.snapshot.queryParamMap.get('section');
    if (section && this.allSections().some(s => s.id === section)) {
      this.selectedSection.set(section);
    }
    // Load cache size on init
    this.refreshCacheSize();
    // Check bookshelf server status
    this.refreshBookshelfStatus();
    // Check TTS API server status
    this.refreshTtsApiStatus();
    // Worker config is owned by WorkerConfigService (via app-multi-worker-toggle)
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
      this.settingsService.setPending(`${pluginId}.${field.key}`, value);
    } else {
      this.settingsService.setPending(field.key, value);
    }
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

  /** Wipe all of BookForge's downloaded data (keeps the user's library), then
   *  tell them how to finish removing the app itself. */
  async removeAllData(): Promise<void> {
    const { confirmed } = await this.electronService.showConfirmDialog({
      type: 'warning',
      title: 'Remove all BookForge data?',
      message: 'This deletes everything BookForge downloaded — the audiobook engine, voice & AI models, language packs, GPU components, caches, and settings.',
      detail: 'Your audiobook library and books are kept — those are your files. This cannot be undone.',
      confirmLabel: 'Remove all data',
      cancelLabel: 'Cancel',
    });
    if (!confirmed) return;

    this.removingData.set(true);
    this.clearCacheStatus.set(null);
    try {
      const result = await this.electronService.removeAllData();
      const freed = result?.freedBytes ? ` (${this.formatBytes(result.freedBytes)} freed)` : '';
      const finishStep = this.isMac()
        ? 'To finish, quit BookForge and drag it from your Applications folder to the Trash.'
        : 'To finish, quit BookForge and run the uninstaller (Windows Settings → Apps → BookForge).';
      await this.electronService.showMessageDialog({
        type: 'info',
        title: 'BookForge data removed',
        message: `All BookForge data has been removed${freed}.`,
        detail: `${finishStep}\n\nYour library and books were left untouched.`,
      });
      this.totalCacheSize.set(0);
    } catch (err) {
      this.clearCacheStatus.set({ success: false, message: `Failed to remove data: ${err}` });
    } finally {
      this.removingData.set(false);
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
        externalAudiobooksDir: config.externalAudiobooksDir,
      });

      if (result.success && result.data) {
        this.bookshelfStatus.set(result.data);
        this.settingsService.updateBookshelfConfig({ enabled: true });
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
        this.settingsService.updateBookshelfConfig({ enabled: false });
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
  private patchBookshelfDraft(updates: { port?: number; externalAudiobooksDir?: string }): void {
    this.bookshelfDraft.set({ ...(this.bookshelfDraft() ?? {}), ...updates });
  }

  updateBookshelfPort(port: number): void {
    if (port >= 1 && port <= 65535) {
      this.patchBookshelfDraft({ port });
    }
  }

  updateExternalAudiobooksDir(dirPath: string): void {
    this.patchBookshelfDraft({ externalAudiobooksDir: dirPath || undefined });
  }

  async browseExternalAudiobooksDir(): Promise<void> {
    const result = await this.electronService.openFolderDialog();
    if (result.success && result.folderPath) {
      this.patchBookshelfDraft({ externalAudiobooksDir: result.folderPath });
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
      // Push the external-folder change to a running server so it takes effect live
      if ('externalAudiobooksDir' in draft) {
        await this.electronService.bookshelfUpdateConfig({ externalAudiobooksDir: draft.externalAudiobooksDir });
      }
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
        externalAudiobooksDir: config.externalAudiobooksDir,
      });

      if (result.success && result.data) {
        this.bookshelfStatus.set(result.data);
        this.settingsService.updateBookshelfConfig({ enabled: true });
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
  // TTS API Server Methods
  // ─────────────────────────────────────────────────────────────────────────────

  async refreshTtsApiStatus(): Promise<void> {
    try {
      const result = await this.electronService.ttsApiStatus();
      if (result.success && result.data) {
        this.ttsApiStatus.set(result.data);
      }
    } catch (err) {
      console.error('Failed to get TTS API server status:', err);
    }
  }

  updateTtsApiPort(port: number): void {
    if (port >= 1 && port <= 65535) {
      this.ttsApiDraft.set({ ...(this.ttsApiDraft() ?? {}), port });
    }
  }

  toggleTtsApiLan(enabled: boolean): void {
    this.ttsApiDraft.set({ ...(this.ttsApiDraft() ?? {}), host: enabled ? '0.0.0.0' : '127.0.0.1' });
  }

  /** Persist all TTS Server edits: restart the WS server and/or set worker count. */
  async saveTtsServer(): Promise<void> {
    if (!this.ttsServerDirty()) return;
    this.ttsApiSaving.set(true);
    this.ttsApiError.set(null);

    try {
      // Port / host → restarts the WebSocket server
      const apiDraft = this.ttsApiDraft();
      if (apiDraft && (apiDraft.port !== undefined || apiDraft.host !== undefined)) {
        const result = await this.electronService.ttsApiConfigure(apiDraft);
        if (result.success && result.data) {
          this.ttsApiStatus.set(result.data);
          this.ttsApiDraft.set(null);
        } else {
          this.ttsApiError.set(result.error || 'Failed to apply TTS server settings');
          return;
        }
      }
    } catch (err) {
      this.ttsApiError.set(err instanceof Error ? err.message : 'Failed to save TTS server settings');
    } finally {
      this.ttsApiSaving.set(false);
    }
  }

  discardTtsServer(): void {
    this.ttsApiDraft.set(null);
    this.ttsApiError.set(null);
  }

  copyTtsApiToken(): void {
    const token = this.ttsApiStatus()?.token;
    if (!token) return;
    navigator.clipboard.writeText(token);
    this.ttsApiCopied.set(true);
    if (this.ttsApiCopiedTimer) clearTimeout(this.ttsApiCopiedTimer);
    this.ttsApiCopiedTimer = setTimeout(() => this.ttsApiCopied.set(false), 2000);
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
    if (key in draft) return draft[key] || '';
    return this.toolPathsConfig()[key] || '';
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
        e2aPath: this.getToolPathValue('wslE2aPath') || undefined,
      });

      if (result.success && result.data) {
        this.wslSetupStatus.set(result.data);
      }
    } catch (err) {
      console.error('Failed to verify WSL setup:', err);
      this.wslSetupStatus.set({
        valid: false,
        condaFound: false,
        e2aFound: false,
        orpheusEnvFound: false,
        errors: [err instanceof Error ? err.message : 'Unknown error'],
      });
    } finally {
      this.wslVerifying.set(false);
    }
  }

  toggleWsl2ForOrpheus(enabled: boolean): void {
    this.updateToolPath('useWsl2ForOrpheus', enabled ? 'true' : '');
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
