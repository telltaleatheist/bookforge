import { Injectable, inject, signal, computed } from '@angular/core';
import { ElectronService } from './electron.service';
import {
  AIConfig,
  DEFAULT_AI_CONFIG,
  OLLAMA_MODELS,
  CLAUDE_MODELS,
  OPENAI_MODELS
} from '../models/ai-config.types';

/**
 * Setting field types matching plugin-types.ts
 */
export type SettingFieldType = 'string' | 'number' | 'boolean' | 'select' | 'path' | 'password';

/**
 * Schema for a setting field
 */
export interface SettingField {
  key: string;
  type: SettingFieldType;
  label: string;
  description?: string;
  default: unknown;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  placeholder?: string;
}

/**
 * A settings section (built-in or from plugin)
 */
export interface SettingsSection {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  fields: SettingField[];
  isPlugin?: boolean;
}

/**
 * SettingsService - Manages application settings
 *
 * Provides:
 * - Built-in settings sections (General, Appearance)
 * - Plugin settings sections (dynamically registered)
 * - Persistence to ~/Documents/BookForge/settings.json
 */
@Injectable({
  providedIn: 'root'
})
export class SettingsService {
  private readonly electron = inject(ElectronService);

  // All registered settings sections
  readonly sections = signal<SettingsSection[]>([]);

  // Saved settings values (persisted to localStorage)
  readonly values = signal<Record<string, unknown>>({});

  // Pending changes (not yet saved)
  readonly pendingValues = signal<Record<string, unknown>>({});

  // Loading state
  readonly loading = signal(false);

  // Whether there are unsaved changes
  readonly hasUnsavedChanges = computed(() => {
    return Object.keys(this.pendingValues()).length > 0;
  });

  constructor() {
    this.initializeBuiltinSections();
    this.loadSettings();
  }

  /**
   * Register built-in settings sections
   */
  private initializeBuiltinSections(): void {
    const builtinSections: SettingsSection[] = [
      {
        id: 'library',
        name: 'Library',
        description: 'Configure your BookForge library location',
        icon: '📚',
        fields: [], // Library section has custom UI
      },
      {
        id: 'general',
        name: 'General',
        description: 'General application settings',
        icon: '⚙️',
        fields: [
          {
            key: 'maxRecentFiles',
            type: 'number',
            label: 'Recent files limit',
            description: 'Maximum number of recent files to remember',
            default: 10,
            min: 5,
            max: 50,
          },
          {
            key: 'diffIgnoreWhitespace',
            type: 'boolean',
            label: 'Ignore whitespace in diffs',
            description: 'When reviewing AI cleanup changes, ignore differences in whitespace, paragraph breaks, and newlines',
            default: false,
          },
        ],
      },
      {
        id: 'storage',
        name: 'Storage',
        description: 'Manage cached data and storage',
        icon: '💾',
        fields: [], // Storage section has custom UI, not standard fields
      },
      {
        id: 'ai',
        name: 'AI',
        description: 'Configure AI provider for OCR text cleanup',
        icon: '🤖',
        fields: [], // AI section has custom UI
      },
      {
        id: 'audiobook',
        name: 'Audiobook',
        description: 'Configure audiobook output settings',
        icon: '🎧',
        fields: [
          {
            key: 'audiobookOutputDir',
            type: 'path',
            label: 'Output Directory',
            description: 'Where completed audiobooks are saved. Leave empty for default (~/Documents/BookForge/audiobooks)',
            default: '',
            placeholder: 'Default: ~/Documents/BookForge/audiobooks',
          },
          {
            key: 'e2aPath',
            type: 'path',
            label: 'ebook2audiobook Path',
            description: 'Path to ebook2audiobook installation folder',
            default: '',
            placeholder: 'Auto-detect',
          },
          {
            key: 'condaPath',
            type: 'path',
            label: 'Conda Executable',
            description: 'Path to conda executable. Leave empty for auto-detect.',
            default: '',
            placeholder: 'Auto-detect',
          },
          {
            key: 'e2aTmpPath',
            type: 'path',
            label: 'ebook2audiobook Tmp Path',
            description: 'Path to the ebook2audiobook tmp folder containing incomplete sessions. Used by the Reassembly feature.',
            default: '',
            placeholder: 'Default: ~/Projects/ebook2audiobook/tmp',
          },
        ],
      },
      {
        id: 'libraryServer',
        name: 'Library Server',
        description: 'Share your book library on the network',
        icon: '🌐',
        fields: [], // Library Server section has custom UI
      },
      {
        id: 'tools',
        name: 'External Tools',
        description: 'Configure paths to external tools (conda, ffmpeg, etc.)',
        icon: '🔧',
        fields: [], // Tools section has custom UI
      },
    ];

    this.sections.set(builtinSections);
  }

  /**
   * Register a plugin settings section
   */
  registerPluginSection(section: SettingsSection): void {
    this.sections.update(sections => {
      // Remove existing section with same ID
      const filtered = sections.filter(s => s.id !== section.id);
      return [...filtered, { ...section, isPlugin: true }];
    });
  }

  /**
   * Unregister a plugin settings section
   */
  unregisterPluginSection(sectionId: string): void {
    this.sections.update(sections =>
      sections.filter(s => s.id !== sectionId)
    );
  }

  /**
   * Load settings from storage
   */
  async loadSettings(): Promise<void> {
    this.loading.set(true);

    try {
      // Load from localStorage for now (electron storage could be added later)
      const stored = localStorage.getItem('bookforge-settings');
      if (stored) {
        this.values.set(JSON.parse(stored));
      } else {
        // Initialize with defaults
        this.initializeDefaults();
      }

      // Configure e2a paths in main process
      await this.applyE2aPaths();
    } catch {
      this.initializeDefaults();
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Apply e2a path settings to the main process
   * Called after loading settings and when paths are changed
   */
  private async applyE2aPaths(): Promise<void> {
    try {
      const e2aPath = this.get<string>('e2aPath') || '';
      const condaPath = this.get<string>('condaPath') || '';
      await this.electron.configureE2aPaths({ e2aPath, condaPath });
    } catch (err) {
      console.error('[SettingsService] Failed to apply e2a paths:', err);
    }
  }

  /**
   * Save settings to storage
   */
  async saveSettings(): Promise<void> {
    try {
      localStorage.setItem('bookforge-settings', JSON.stringify(this.values()));
    } catch (err) {
      console.error('Failed to save settings:', err);
    }
  }

  /**
   * Get a setting value (checks pending values first, then saved values)
   */
  get<T>(key: string): T {
    // Check pending values first
    const pendingValue = this.pendingValues()[key];
    if (pendingValue !== undefined) {
      return pendingValue as T;
    }

    // Then check saved values
    const value = this.values()[key];
    if (value !== undefined) {
      return value as T;
    }

    // Find default from schema
    for (const section of this.sections()) {
      const field = section.fields.find(f => f.key === key);
      if (field) {
        return field.default as T;
      }
    }

    return undefined as T;
  }

  /**
   * Get only the saved value (ignoring pending changes)
   */
  getSaved<T>(key: string): T {
    return this.values()[key] as T;
  }

  /**
   * Set a setting value as pending (does NOT auto-save)
   */
  setPending(key: string, value: unknown): void {
    this.pendingValues.update(v => ({ ...v, [key]: value }));
  }

  /**
   * Save all pending changes
   */
  async savePendingChanges(): Promise<void> {
    const pending = this.pendingValues();
    if (Object.keys(pending).length === 0) return;

    // Merge pending into values
    this.values.update(v => ({ ...v, ...pending }));

    // Clear pending
    this.pendingValues.set({});

    // Persist to storage
    await this.saveSettings();

    // Apply e2a path changes if relevant
    if ('e2aPath' in pending || 'condaPath' in pending) {
      this.applyE2aPaths();
    }

    console.log('[SETTINGS] Saved pending changes:', Object.keys(pending));
  }

  /**
   * Discard all pending changes
   */
  discardPendingChanges(): void {
    this.pendingValues.set({});
  }

  /**
   * Set a setting value and save immediately (legacy behavior)
   */
  set(key: string, value: unknown): void {
    this.values.update(v => ({ ...v, [key]: value }));
    // Also clear from pending if it was there
    this.pendingValues.update(v => {
      const updated = { ...v };
      delete updated[key];
      return updated;
    });
    this.saveSettings();

    // Apply e2a path changes immediately
    if (key === 'e2aPath' || key === 'condaPath') {
      this.applyE2aPaths();
    }
  }

  /**
   * Set multiple settings at once
   */
  setMultiple(settings: Record<string, unknown>): void {
    this.values.update(v => ({ ...v, ...settings }));
    this.saveSettings();
  }

  /**
   * Reset a section to defaults
   */
  resetSection(sectionId: string): void {
    const section = this.sections().find(s => s.id === sectionId);
    if (!section) return;

    const defaults: Record<string, unknown> = {};
    for (const field of section.fields) {
      defaults[field.key] = field.default;
    }

    // Clear any pending values for this section
    this.pendingValues.update(v => {
      const updated = { ...v };
      for (const key of Object.keys(defaults)) {
        delete updated[key];
      }
      return updated;
    });

    this.values.update(v => {
      const updated = { ...v };
      for (const key of Object.keys(defaults)) {
        updated[key] = defaults[key];
      }
      return updated;
    });

    this.saveSettings();
  }

  /**
   * Reset all settings to defaults
   */
  resetAll(): void {
    this.initializeDefaults();
    this.saveSettings();
  }

  /**
   * Initialize all settings to their defaults
   */
  private initializeDefaults(): void {
    const defaults: Record<string, unknown> = {};

    for (const section of this.sections()) {
      for (const field of section.fields) {
        defaults[field.key] = field.default;
      }
    }

    // Initialize AI config with defaults
    defaults['aiConfig'] = { ...DEFAULT_AI_CONFIG };

    // Initialize library server config with defaults
    defaults['libraryServerConfig'] = {
      enabled: false,
      booksPath: '',
      port: 8765
    };

    this.values.set(defaults);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // AI Configuration
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get AI configuration
   */
  getAIConfig(): AIConfig {
    const config = this.values()['aiConfig'] as AIConfig | undefined;
    if (!config) {
      return { ...DEFAULT_AI_CONFIG };
    }
    // Merge with defaults to ensure all fields exist
    return {
      ...DEFAULT_AI_CONFIG,
      ...config,
      ollama: { ...DEFAULT_AI_CONFIG.ollama, ...config.ollama },
      claude: { ...DEFAULT_AI_CONFIG.claude, ...config.claude },
      openai: { ...DEFAULT_AI_CONFIG.openai, ...config.openai }
    };
  }

  /**
   * Set AI configuration
   */
  setAIConfig(config: AIConfig): void {
    this.values.update(v => ({ ...v, aiConfig: config }));
    this.saveSettings();
  }

  /**
   * Update a single AI config field
   */
  updateAIConfig(updates: Partial<AIConfig>): void {
    const current = this.getAIConfig();
    this.setAIConfig({ ...current, ...updates });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Library Server Configuration
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Library server configuration interface
   */
  getLibraryServerConfig(): { enabled: boolean; booksPath: string; port: number } {
    const config = this.values()['libraryServerConfig'] as { enabled: boolean; booksPath: string; port: number } | undefined;
    return config || { enabled: false, booksPath: '', port: 8765 };
  }

  /**
   * Set library server configuration
   */
  setLibraryServerConfig(config: { enabled: boolean; booksPath: string; port: number }): void {
    this.values.update(v => ({ ...v, libraryServerConfig: config }));
    this.saveSettings();
  }

  /**
   * Update library server configuration
   */
  updateLibraryServerConfig(updates: Partial<{ enabled: boolean; booksPath: string; port: number }>): void {
    const current = this.getLibraryServerConfig();
    this.setLibraryServerConfig({ ...current, ...updates });
  }
}
