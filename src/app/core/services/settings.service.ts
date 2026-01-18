import { Injectable, inject, signal } from '@angular/core';
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

  // Current settings values
  readonly values = signal<Record<string, unknown>>({});

  // Loading state
  readonly loading = signal(false);

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
    } catch {
      this.initializeDefaults();
    } finally {
      this.loading.set(false);
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
   * Get a setting value
   */
  get<T>(key: string): T {
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
   * Set a setting value
   */
  set(key: string, value: unknown): void {
    this.values.update(v => ({ ...v, [key]: value }));
    this.saveSettings();
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
}
