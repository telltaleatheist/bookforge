/**
 * Plugin System Types for BookForgeApp
 *
 * Plugins invoke external tools as subprocesses - no bundled interpreters.
 * Each plugin gets its own settings section in the Settings page.
 */

import { IpcMainInvokeEvent } from 'electron';

// Plugin capabilities
export type PluginCapability = 'ocr' | 'tts' | 'export' | 'processing';

// Setting field types
export type SettingFieldType = 'string' | 'number' | 'boolean' | 'select' | 'path';

/**
 * Schema for a single plugin setting field
 */
export interface PluginSettingField {
  key: string;
  type: SettingFieldType;
  label: string;
  description?: string;
  default: unknown;
  options?: { value: string; label: string }[]; // for select type
  min?: number;
  max?: number; // for number type
  placeholder?: string; // for string/path type
}

/**
 * Plugin manifest - describes the plugin
 */
export interface PluginManifest {
  id: string; // 'surya-ocr', 'ebook2audiobook'
  name: string; // Display name
  version: string;
  description: string;
  capabilities: PluginCapability[];
  settingsSchema: PluginSettingField[];
}

/**
 * Tool availability status
 */
export interface ToolAvailability {
  available: boolean;
  version?: string;
  path?: string;
  error?: string;
  installInstructions?: string;
}

/**
 * Progress event for long-running plugin operations
 */
export interface PluginProgress {
  pluginId: string;
  operation: string;
  current: number;
  total: number;
  message?: string;
  percentage?: number;
}

/**
 * IPC handler definition for plugins
 */
export interface PluginIpcHandler {
  channel: string; // Will be prefixed with plugin:{pluginId}:
  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;
}

/**
 * Plugin info sent to renderer
 */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  capabilities: PluginCapability[];
  available: boolean;
  availabilityDetails?: ToolAvailability;
  settingsSchema: PluginSettingField[];
}

/**
 * Base plugin interface that all plugins must implement
 */
export interface Plugin {
  readonly manifest: PluginManifest;

  /**
   * Initialize the plugin (called on app startup)
   */
  initialize(): Promise<void>;

  /**
   * Dispose of plugin resources (called on app shutdown)
   */
  dispose(): Promise<void>;

  /**
   * Check if the external tool is available
   */
  checkAvailability(): Promise<ToolAvailability>;

  /**
   * Get IPC handlers this plugin provides
   */
  getIpcHandlers(): PluginIpcHandler[];

  /**
   * Called when settings are updated
   */
  onSettingsChanged?(settings: Record<string, unknown>): void;
}

/**
 * Abstract base class for plugins with common functionality
 */
export abstract class BasePlugin implements Plugin {
  abstract readonly manifest: PluginManifest;

  protected settings: Record<string, unknown> = {};

  async initialize(): Promise<void> {
    // Load default settings
    this.settings = this.getDefaultSettings();
  }

  async dispose(): Promise<void> {
    // Override if cleanup needed
  }

  abstract checkAvailability(): Promise<ToolAvailability>;

  abstract getIpcHandlers(): PluginIpcHandler[];

  onSettingsChanged(settings: Record<string, unknown>): void {
    this.settings = { ...this.settings, ...settings };
  }

  protected getDefaultSettings(): Record<string, unknown> {
    const defaults: Record<string, unknown> = {};
    for (const field of this.manifest.settingsSchema) {
      defaults[field.key] = field.default;
    }
    return defaults;
  }

  protected getSetting<T>(key: string): T {
    return this.settings[key] as T;
  }
}
