import { Injectable, inject, signal } from '@angular/core';
import { ElectronService } from './electron.service';

/**
 * Setting field types matching plugin-types.ts
 */
export type SettingFieldType = 'string' | 'number' | 'boolean' | 'select' | 'path';

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
            key: 'autoSave',
            type: 'boolean',
            label: 'Auto-save projects',
            description: 'Automatically save projects when changes are made',
            default: true,
          },
          {
            key: 'autoSaveInterval',
            type: 'number',
            label: 'Auto-save interval (seconds)',
            description: 'How often to auto-save (minimum 10 seconds)',
            default: 30,
            min: 10,
            max: 300,
          },
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
        id: 'appearance',
        name: 'Appearance',
        description: 'Visual settings',
        icon: '🎨',
        fields: [
          {
            key: 'theme',
            type: 'select',
            label: 'Theme',
            description: 'Application color theme',
            default: 'dark',
            options: [
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
              { value: 'system', label: 'System' },
            ],
          },
          {
            key: 'uiScale',
            type: 'select',
            label: 'UI Scale',
            description: 'Interface size',
            default: 'normal',
            options: [
              { value: 'compact', label: 'Compact' },
              { value: 'normal', label: 'Normal' },
              { value: 'large', label: 'Large' },
            ],
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

    this.values.set(defaults);
  }
}
