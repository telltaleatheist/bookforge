import { Component, inject, signal, computed, ChangeDetectionStrategy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { SettingsService, SettingsSection, SettingField } from '../../core/services/settings.service';
import { PluginService, PluginInfo } from '../../core/services/plugin.service';
import { ElectronService } from '../../core/services/electron.service';
import { LibraryService } from '../../core/services/library.service';
import { DesktopButtonComponent } from '../../creamsicle-desktop';
import {
  AIConfig,
  AIProvider,
  ProviderStatus,
  OLLAMA_MODELS,
  CLAUDE_MODELS,
  OPENAI_MODELS
} from '../../core/models/ai-config.types';

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

                <div class="help-text">
                  <p>
                    <strong>Note:</strong> Changing the library location does not move existing files.
                    If you've copied your library to a new location, select the new folder here.
                  </p>
                  <p style="margin-top: 8px;">
                    <strong>Current structure:</strong><br/>
                    {{ currentLibraryPath() }}/projects/ - Project files (.bfp)<br/>
                    {{ currentLibraryPath() }}/audiobooks/ - Audiobook exports<br/>
                    {{ currentLibraryPath() }}/cache/ - Page render cache
                  </p>
                </div>
              </div>
            } @else if (section.id === 'storage') {
              <!-- Storage section has custom UI -->
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
            } @else if (section.id === 'ai') {
              <!-- AI Configuration Section -->
              <div class="ai-section">
                <!-- Provider Selection -->
                <div class="ai-provider-select">
                  <h3>AI Provider</h3>
                  <p class="field-description">Select which AI service to use for OCR text cleanup</p>
                  <div class="provider-cards">
                    <button
                      class="provider-card"
                      [class.selected]="aiConfig().provider === 'ollama'"
                      (click)="setAIProvider('ollama')"
                    >
                      <span class="provider-icon">🦙</span>
                      <span class="provider-name">Ollama</span>
                      <span class="provider-desc">Local, free</span>
                      @if (ollamaStatus(); as status) {
                        <span class="provider-status" [class.available]="status.available" [class.unavailable]="!status.available">
                          {{ status.available ? 'Connected' : 'Not running' }}
                        </span>
                      }
                    </button>
                    <button
                      class="provider-card"
                      [class.selected]="aiConfig().provider === 'claude'"
                      (click)="setAIProvider('claude')"
                    >
                      <span class="provider-icon">🧠</span>
                      <span class="provider-name">Claude</span>
                      <span class="provider-desc">Anthropic API</span>
                      @if (aiConfig().claude.apiKey) {
                        <span class="provider-status available">API Key Set</span>
                      }
                    </button>
                    <button
                      class="provider-card"
                      [class.selected]="aiConfig().provider === 'openai'"
                      (click)="setAIProvider('openai')"
                    >
                      <span class="provider-icon">🤖</span>
                      <span class="provider-name">OpenAI</span>
                      <span class="provider-desc">ChatGPT API</span>
                      @if (aiConfig().openai.apiKey) {
                        <span class="provider-status available">API Key Set</span>
                      }
                    </button>
                  </div>
                </div>

                <!-- Provider-specific settings -->
                <div class="provider-settings">
                  @switch (aiConfig().provider) {
                    @case ('ollama') {
                      <div class="settings-group">
                        <h4>Ollama Settings</h4>
                        <div class="field-row">
                          <div class="field-info">
                            <label class="field-label">Server URL</label>
                            <p class="field-description">Ollama server address</p>
                          </div>
                          <div class="field-control">
                            <input
                              type="text"
                              class="text-input"
                              [value]="aiConfig().ollama.baseUrl"
                              (change)="updateOllamaUrl($any($event.target).value)"
                            />
                          </div>
                        </div>
                        <div class="field-row">
                          <div class="field-info">
                            <label class="field-label">Connection Status</label>
                          </div>
                          <div class="field-control">
                            <desktop-button
                              variant="ghost"
                              size="sm"
                              (click)="checkOllamaConnection()"
                              [disabled]="ollamaChecking()"
                            >
                              {{ ollamaChecking() ? 'Checking...' : 'Test Connection' }}
                            </desktop-button>
                          </div>
                        </div>
                        @if (ollamaStatus(); as status) {
                          <div class="connection-status" [class.success]="status.available" [class.error]="!status.available">
                            @if (status.available) {
                              ✓ Connected to Ollama
                              @if (status.models && status.models.length > 0) {
                                <span class="models-available">({{ status.models.length }} models available)</span>
                              }
                            } @else {
                              ✕ {{ status.error || 'Could not connect to Ollama' }}
                            }
                          </div>
                        }
                        <div class="field-row">
                          <div class="field-info">
                            <label class="field-label">Model</label>
                            <p class="field-description">AI model to use for text cleanup</p>
                          </div>
                          <div class="field-control">
                            @if (ollamaModels().length > 0) {
                              <select
                                class="select-input"
                                [value]="aiConfig().ollama.model"
                                (change)="updateOllamaModel($any($event.target).value)"
                              >
                                @for (model of ollamaModels(); track model.value) {
                                  <option [value]="model.value">{{ model.label }}</option>
                                }
                              </select>
                            } @else {
                              <span class="no-models-hint">Test connection to see available models</span>
                            }
                          </div>
                        </div>
                      </div>
                    }
                    @case ('claude') {
                      <div class="settings-group">
                        <h4>Claude Settings</h4>
                        <div class="field-row">
                          <div class="field-info">
                            <label class="field-label">API Key</label>
                            <p class="field-description">Your Anthropic API key</p>
                          </div>
                          <div class="field-control">
                            <input
                              type="password"
                              class="text-input api-key-input"
                              [value]="aiConfig().claude.apiKey"
                              placeholder="sk-ant-..."
                              (change)="updateClaudeApiKey($any($event.target).value)"
                            />
                          </div>
                        </div>
                        <div class="field-row">
                          <div class="field-info">
                            <label class="field-label">Model</label>
                            <p class="field-description">Claude model to use</p>
                          </div>
                          <div class="field-control">
                            @if (claudeModelsLoading()) {
                              <span class="no-models-hint">Loading models...</span>
                            } @else if (claudeModels().length > 0) {
                              <select
                                class="select-input"
                                [value]="aiConfig().claude.model"
                                (change)="updateClaudeModel($any($event.target).value)"
                              >
                                @for (model of claudeModels(); track model.value) {
                                  <option [value]="model.value">{{ model.label }}</option>
                                }
                              </select>
                            } @else {
                              <span class="no-models-hint">Enter API key first</span>
                            }
                          </div>
                        </div>
                        <div class="api-key-hint">
                          Get your API key from <a href="#" (click)="openExternal('https://console.anthropic.com/settings/keys')">console.anthropic.com</a>
                        </div>
                      </div>
                    }
                    @case ('openai') {
                      <div class="settings-group">
                        <h4>OpenAI Settings</h4>
                        <div class="field-row">
                          <div class="field-info">
                            <label class="field-label">API Key</label>
                            <p class="field-description">Your OpenAI API key</p>
                          </div>
                          <div class="field-control">
                            <input
                              type="password"
                              class="text-input api-key-input"
                              [value]="aiConfig().openai.apiKey"
                              placeholder="sk-..."
                              (change)="updateOpenAIApiKey($any($event.target).value)"
                            />
                          </div>
                        </div>
                        <div class="field-row">
                          <div class="field-info">
                            <label class="field-label">Model</label>
                            <p class="field-description">OpenAI model to use</p>
                          </div>
                          <div class="field-control">
                            @if (openaiModelsLoading()) {
                              <span class="no-models-hint">Loading models...</span>
                            } @else if (openaiModels().length > 0) {
                              <select
                                class="select-input"
                                [value]="aiConfig().openai.model"
                                (change)="updateOpenAIModel($any($event.target).value)"
                              >
                                @for (model of openaiModels(); track model.value) {
                                  <option [value]="model.value">{{ model.label }}</option>
                                }
                              </select>
                            } @else {
                              <span class="no-models-hint">Enter API key first</span>
                            }
                          </div>
                        </div>
                        <div class="api-key-hint">
                          Get your API key from <a href="#" (click)="openExternal('https://platform.openai.com/api-keys')">platform.openai.com</a>
                        </div>
                      </div>
                    }
                  }
                </div>
              </div>
            } @else if (section.id === 'libraryServer') {
              <!-- Library Server Section -->
              <div class="library-server-section">
                <!-- Server Status -->
                <div class="server-status-card" [class.running]="libraryServerStatus()?.running">
                  <div class="status-indicator">
                    <span class="status-dot"></span>
                    <span class="status-text">
                      {{ libraryServerStatus()?.running ? 'Running' : 'Stopped' }}
                    </span>
                  </div>
                  @if (libraryServerStatus()?.running) {
                    <div class="server-addresses">
                      <h4>Access URLs</h4>
                      @for (address of libraryServerStatus()?.addresses || []; track address) {
                        <a class="server-address" [href]="address" target="_blank">{{ address }}</a>
                      }
                    </div>
                  }
                </div>

                <!-- Configuration -->
                <div class="settings-group">
                  <h4>Configuration</h4>

                  <!-- Books Folder -->
                  <div class="field-row">
                    <div class="field-info">
                      <label class="field-label">Books Folder</label>
                      <p class="field-description">Location of your book library</p>
                    </div>
                    <div class="field-control">
                      <div class="path-input-group">
                        <input
                          type="text"
                          class="text-input path-input"
                          [value]="libraryServerConfig().booksPath"
                          placeholder="Select a folder..."
                          readonly
                        />
                        <desktop-button
                          variant="ghost"
                          size="sm"
                          (click)="browseForBooksFolder()"
                          [disabled]="libraryServerStatus()?.running ?? false"
                        >
                          Browse...
                        </desktop-button>
                      </div>
                    </div>
                  </div>

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
                        [value]="libraryServerConfig().port"
                        min="1"
                        max="65535"
                        (change)="updateLibraryServerPort(+$any($event.target).value)"
                        [disabled]="libraryServerStatus()?.running ?? false"
                      />
                    </div>
                  </div>
                </div>

                <!-- Control Buttons -->
                <div class="server-controls">
                  @if (libraryServerStatus()?.running) {
                    <desktop-button
                      variant="danger"
                      size="md"
                      (click)="stopLibraryServer()"
                      [disabled]="libraryServerLoading()"
                    >
                      {{ libraryServerLoading() ? 'Stopping...' : 'Stop Server' }}
                    </desktop-button>
                  } @else {
                    <desktop-button
                      variant="primary"
                      size="md"
                      (click)="startLibraryServer()"
                      [disabled]="libraryServerLoading() || !libraryServerConfig().booksPath"
                    >
                      {{ libraryServerLoading() ? 'Starting...' : 'Start Server' }}
                    </desktop-button>
                  }
                </div>

                @if (libraryServerError(); as error) {
                  <div class="status-message error">
                    {{ error }}
                  </div>
                }

                <!-- Help text -->
                <div class="help-text">
                  <p>
                    Start the server to browse your book library from any device on your network.
                    Access the library from your phone or tablet using the URLs shown above.
                  </p>
                </div>
              </div>
            } @else if (section.id === 'tools') {
              <!-- External Tools Section -->
              <div class="tools-section">
                @if (toolPathsLoading()) {
                  <p class="loading-hint">Loading tool paths...</p>
                }

                <!-- Conda Path -->
                <div class="tool-row">
                  <div class="tool-info">
                    <h4>Conda</h4>
                    <p class="tool-description">Python environment manager (required for TTS)</p>
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

                <!-- DeepFilter Conda Env -->
                <div class="tool-row">
                  <div class="tool-info">
                    <h4>DeepFilterNet Environment</h4>
                    <p class="tool-description">Conda environment name with DeepFilterNet installed</p>
                    @if (getToolStatus('deepFilterEnv'); as status) {
                      <div class="tool-status detected">
                        @if (status.configured) {
                          <span class="status-badge configured">Configured</span>
                        } @else {
                          <span class="status-badge detected">Default</span>
                        }
                        <span class="tool-path">{{ status.path }}</span>
                      </div>
                    }
                  </div>
                  <div class="tool-control">
                    <input
                      type="text"
                      class="text-input"
                      [value]="getToolPathValue('deepFilterCondaEnv')"
                      placeholder="ebook2audiobook"
                      (change)="updateToolPath('deepFilterCondaEnv', $any($event.target).value)"
                    />
                  </div>
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

    // Library Server Section Styles
    .library-server-section {
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
  `]
})
export class SettingsComponent implements OnInit {
  private readonly router = inject(Router);
  private readonly settingsService = inject(SettingsService);
  private readonly pluginService = inject(PluginService);
  private readonly electronService = inject(ElectronService);
  private readonly libraryService = inject(LibraryService);

  readonly selectedSection = signal('library');

  // Library section state
  readonly currentLibraryPath = computed(() => this.libraryService.libraryPath() || '~/Documents/BookForge');
  readonly libraryChangeStatus = signal<{ success: boolean; message: string } | null>(null);

  // Storage section state
  readonly totalCacheSize = signal(0);
  readonly cacheLoading = signal(false);
  readonly clearCacheStatus = signal<{ success: boolean; message: string } | null>(null);

  // AI section state
  readonly aiConfig = computed(() => this.settingsService.getAIConfig());
  readonly ollamaStatus = signal<ProviderStatus | null>(null);
  readonly ollamaChecking = signal(false);

  // Dynamic model options - fetched from providers
  readonly fetchedOllamaModels = signal<{ value: string; label: string }[]>([]);
  readonly fetchedClaudeModels = signal<{ value: string; label: string }[]>([]);
  readonly fetchedOpenaiModels = signal<{ value: string; label: string }[]>([]);
  readonly claudeModelsLoading = signal(false);
  readonly openaiModelsLoading = signal(false);

  // Fallback static model options (used only when API unavailable)
  readonly defaultOllamaModels = OLLAMA_MODELS;
  readonly defaultClaudeModels = CLAUDE_MODELS;
  readonly defaultOpenaiModels = OPENAI_MODELS;

  // Computed: use fetched models if available, otherwise use defaults
  readonly ollamaModels = computed(() => {
    const fetched = this.fetchedOllamaModels();
    return fetched.length > 0 ? fetched : this.defaultOllamaModels;
  });

  readonly claudeModels = computed(() => {
    const fetched = this.fetchedClaudeModels();
    // Only show models if API key is provided and models are fetched
    if (!this.aiConfig().claude.apiKey) return [];
    return fetched.length > 0 ? fetched : this.defaultClaudeModels;
  });

  readonly openaiModels = computed(() => {
    const fetched = this.fetchedOpenaiModels();
    // Only show models if API key is provided and models are fetched
    if (!this.aiConfig().openai.apiKey) return [];
    return fetched.length > 0 ? fetched : this.defaultOpenaiModels;
  });

  // Library Server section state
  readonly libraryServerConfig = computed(() => this.settingsService.getLibraryServerConfig());
  readonly libraryServerStatus = signal<{ running: boolean; port: number; addresses: string[]; booksPath: string } | null>(null);
  readonly libraryServerLoading = signal(false);
  readonly libraryServerError = signal<string | null>(null);

  // Tools section state
  readonly toolPathsConfig = signal<Record<string, string | undefined>>({});
  readonly toolPathsStatus = signal<Record<string, { configured: boolean; detected: boolean; path: string }>>({});
  readonly toolPathsLoading = signal(false);
  readonly toolPathsSaveStatus = signal<{ success: boolean; message: string } | null>(null);

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
    // Check library server status
    this.refreshLibraryServerStatus();
    // Load tool paths
    this.refreshToolPaths();
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
      this.libraryChangeStatus.set(null);

      // Set the new library path
      const setResult = await this.libraryService.setLibraryPath(result.folderPath);
      if (setResult.success) {
        this.libraryChangeStatus.set({
          success: true,
          message: `Library location updated to: ${result.folderPath}`
        });
        // Clear status after 5 seconds
        setTimeout(() => this.libraryChangeStatus.set(null), 5000);
      } else {
        this.libraryChangeStatus.set({
          success: false,
          message: setResult.error || 'Failed to update library location'
        });
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // AI Configuration Methods
  // ─────────────────────────────────────────────────────────────────────────────

  setAIProvider(provider: AIProvider): void {
    const config = this.settingsService.getAIConfig();
    this.settingsService.setAIConfig({ ...config, provider });

    // Check Ollama connection when selecting it
    if (provider === 'ollama') {
      this.checkOllamaConnection();
    }
  }

  updateOllamaUrl(url: string): void {
    const config = this.settingsService.getAIConfig();
    this.settingsService.setAIConfig({
      ...config,
      ollama: { ...config.ollama, baseUrl: url }
    });
  }

  updateOllamaModel(model: string): void {
    const config = this.settingsService.getAIConfig();
    this.settingsService.setAIConfig({
      ...config,
      ollama: { ...config.ollama, model }
    });
  }

  updateClaudeApiKey(apiKey: string): void {
    const config = this.settingsService.getAIConfig();
    this.settingsService.setAIConfig({
      ...config,
      claude: { ...config.claude, apiKey }
    });
    // Fetch Claude models when API key is provided
    if (apiKey && apiKey.startsWith('sk-ant-')) {
      this.fetchClaudeModels(apiKey);
    } else {
      this.fetchedClaudeModels.set([]);
    }
  }

  updateClaudeModel(model: string): void {
    const config = this.settingsService.getAIConfig();
    this.settingsService.setAIConfig({
      ...config,
      claude: { ...config.claude, model }
    });
  }

  updateOpenAIApiKey(apiKey: string): void {
    const config = this.settingsService.getAIConfig();
    this.settingsService.setAIConfig({
      ...config,
      openai: { ...config.openai, apiKey }
    });
    // Fetch OpenAI models when API key is provided
    if (apiKey && apiKey.startsWith('sk-')) {
      this.fetchOpenAIModels(apiKey);
    } else {
      this.fetchedOpenaiModels.set([]);
    }
  }

  updateOpenAIModel(model: string): void {
    const config = this.settingsService.getAIConfig();
    this.settingsService.setAIConfig({
      ...config,
      openai: { ...config.openai, model }
    });
  }

  async checkOllamaConnection(): Promise<void> {
    this.ollamaChecking.set(true);
    try {
      const result = await this.electronService.checkAIConnection('ollama');
      this.ollamaStatus.set(result);

      // Populate fetched models from Ollama
      if (result.available && result.models) {
        this.fetchedOllamaModels.set(
          result.models.map(m => ({ value: m, label: m }))
        );
      }
    } catch (err) {
      this.ollamaStatus.set({
        available: false,
        error: err instanceof Error ? err.message : 'Connection failed'
      });
    } finally {
      this.ollamaChecking.set(false);
    }
  }

  private async fetchClaudeModels(apiKey: string): Promise<void> {
    this.claudeModelsLoading.set(true);
    try {
      // Claude doesn't have a public models API, so we use the known models
      // but only show them when API key is valid
      this.fetchedClaudeModels.set([
        { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
        { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' },
        { value: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku' },
        { value: 'claude-3-opus-20240229', label: 'Claude 3 Opus' }
      ]);
    } finally {
      this.claudeModelsLoading.set(false);
    }
  }

  private async fetchOpenAIModels(apiKey: string): Promise<void> {
    this.openaiModelsLoading.set(true);
    try {
      // Fetch models from OpenAI API
      const response = await fetch('https://api.openai.com/v1/models', {
        headers: {
          'Authorization': `Bearer ${apiKey}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        // Filter to only show GPT models suitable for text completion
        const gptModels = (data.data as Array<{ id: string }>)
          .filter(m => m.id.startsWith('gpt-4') || m.id.startsWith('gpt-3.5'))
          .sort((a, b) => b.id.localeCompare(a.id))
          .slice(0, 10)
          .map(m => ({ value: m.id, label: m.id }));

        this.fetchedOpenaiModels.set(gptModels.length > 0 ? gptModels : this.defaultOpenaiModels);
      } else {
        // If API fails, use default models
        this.fetchedOpenaiModels.set(this.defaultOpenaiModels);
      }
    } catch {
      // On error, use default models
      this.fetchedOpenaiModels.set(this.defaultOpenaiModels);
    } finally {
      this.openaiModelsLoading.set(false);
    }
  }

  openExternal(url: string): void {
    // Open URL in system browser
    if (window.electron?.shell) {
      window.electron.shell.openExternal(url);
    } else {
      window.open(url, '_blank');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Library Server Methods
  // ─────────────────────────────────────────────────────────────────────────────

  async refreshLibraryServerStatus(): Promise<void> {
    try {
      const result = await this.electronService.libraryServerGetStatus();
      if (result.success && result.data) {
        this.libraryServerStatus.set(result.data);
      }
    } catch (err) {
      console.error('Failed to get library server status:', err);
    }
  }

  async startLibraryServer(): Promise<void> {
    const config = this.libraryServerConfig();
    if (!config.booksPath) {
      this.libraryServerError.set('Please select a books folder first');
      return;
    }

    this.libraryServerLoading.set(true);
    this.libraryServerError.set(null);

    try {
      const result = await this.electronService.libraryServerStart({
        booksPath: config.booksPath,
        port: config.port
      });

      if (result.success && result.data) {
        this.libraryServerStatus.set(result.data);
        // Update config to mark as enabled
        this.settingsService.updateLibraryServerConfig({ enabled: true });
      } else {
        this.libraryServerError.set(result.error || 'Failed to start server');
      }
    } catch (err) {
      this.libraryServerError.set(err instanceof Error ? err.message : 'Failed to start server');
    } finally {
      this.libraryServerLoading.set(false);
    }
  }

  async stopLibraryServer(): Promise<void> {
    this.libraryServerLoading.set(true);
    this.libraryServerError.set(null);

    try {
      const result = await this.electronService.libraryServerStop();
      if (result.success) {
        this.libraryServerStatus.set({ running: false, port: 0, addresses: [], booksPath: '' });
        // Update config to mark as disabled
        this.settingsService.updateLibraryServerConfig({ enabled: false });
      } else {
        this.libraryServerError.set(result.error || 'Failed to stop server');
      }
    } catch (err) {
      this.libraryServerError.set(err instanceof Error ? err.message : 'Failed to stop server');
    } finally {
      this.libraryServerLoading.set(false);
    }
  }

  async browseForBooksFolder(): Promise<void> {
    const result = await this.electronService.openFolderDialog();
    if (result.success && result.folderPath) {
      this.settingsService.updateLibraryServerConfig({ booksPath: result.folderPath });
      // Auto-start or restart server with new path
      await this.restartLibraryServer();
    }
  }

  async updateLibraryServerPort(port: number): Promise<void> {
    if (port >= 1 && port <= 65535) {
      this.settingsService.updateLibraryServerConfig({ port });
      // Restart server if running with new port
      if (this.libraryServerStatus()?.running) {
        await this.restartLibraryServer();
      }
    }
  }

  private async restartLibraryServer(): Promise<void> {
    const config = this.libraryServerConfig();
    if (!config.booksPath) {
      return;
    }

    this.libraryServerLoading.set(true);
    this.libraryServerError.set(null);

    try {
      // Stop if running
      if (this.libraryServerStatus()?.running) {
        await this.electronService.libraryServerStop();
      }

      // Start with current config
      const result = await this.electronService.libraryServerStart({
        booksPath: config.booksPath,
        port: config.port
      });

      if (result.success && result.data) {
        this.libraryServerStatus.set(result.data);
        this.settingsService.updateLibraryServerConfig({ enabled: true });
      } else {
        this.libraryServerError.set(result.error || 'Failed to start server');
      }
    } catch (err) {
      this.libraryServerError.set(err instanceof Error ? err.message : 'Failed to start server');
    } finally {
      this.libraryServerLoading.set(false);
    }
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
    } catch (err) {
      console.error('Failed to load tool paths:', err);
    } finally {
      this.toolPathsLoading.set(false);
    }
  }

  async updateToolPath(key: string, value: string): Promise<void> {
    this.toolPathsSaveStatus.set(null);
    try {
      const result = await this.electronService.toolPathsUpdateConfig({ [key]: value || undefined });
      if (result.success && result.data) {
        this.toolPathsConfig.set(result.data);
        // Refresh status to show updated detection
        await this.refreshToolPaths();
        this.toolPathsSaveStatus.set({ success: true, message: 'Saved' });
        setTimeout(() => this.toolPathsSaveStatus.set(null), 2000);
      }
    } catch (err) {
      this.toolPathsSaveStatus.set({
        success: false,
        message: err instanceof Error ? err.message : 'Failed to save'
      });
    }
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

      await this.updateToolPath(key, finalPath);
    }
  }

  getToolPathValue(key: string): string {
    const config = this.toolPathsConfig();
    return config[key] || '';
  }

  getToolStatus(key: string): { configured: boolean; detected: boolean; path: string } | undefined {
    const status = this.toolPathsStatus();
    return status[key];
  }
}
