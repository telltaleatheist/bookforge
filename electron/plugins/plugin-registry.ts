/**
 * Plugin Registry - Manages plugin lifecycle and settings
 *
 * Singleton that:
 * - Registers and manages plugins
 * - Handles IPC registration with namespaced channels
 * - Persists plugin settings to ~/Documents/BookForge/settings/plugins/
 */

import { ipcMain, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { Plugin, PluginInfo, PluginProgress, ToolAvailability } from './plugin-types';

export class PluginRegistry {
  private static instance: PluginRegistry;
  private plugins: Map<string, Plugin> = new Map();
  private settingsDir: string;
  private mainWindow: BrowserWindow | null = null;

  private constructor() {
    // Settings stored in ~/Documents/BookForge/settings/plugins/
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    this.settingsDir = path.join(homeDir, 'Documents', 'BookForge', 'settings', 'plugins');
  }

  static getInstance(): PluginRegistry {
    if (!PluginRegistry.instance) {
      PluginRegistry.instance = new PluginRegistry();
    }
    return PluginRegistry.instance;
  }

  /**
   * Set the main window for sending progress events
   */
  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  /**
   * Register a plugin
   */
  async register(plugin: Plugin): Promise<void> {
    const id = plugin.manifest.id;

    if (this.plugins.has(id)) {
      console.warn(`Plugin ${id} already registered, skipping`);
      return;
    }

    console.log(`Registering plugin: ${plugin.manifest.name} (${id})`);

    // Load saved settings
    const savedSettings = this.loadPluginSettings(id);
    if (savedSettings && plugin.onSettingsChanged) {
      plugin.onSettingsChanged(savedSettings);
    }

    // Initialize the plugin
    await plugin.initialize();

    // Register IPC handlers
    this.registerIpcHandlers(plugin);

    this.plugins.set(id, plugin);
  }

  /**
   * Unregister a plugin
   */
  async unregister(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return;

    // Remove IPC handlers
    for (const handler of plugin.getIpcHandlers()) {
      const channel = `plugin:${pluginId}:${handler.channel}`;
      ipcMain.removeHandler(channel);
    }

    // Dispose the plugin
    await plugin.dispose();

    this.plugins.delete(pluginId);
  }

  /**
   * Get all registered plugins
   */
  async getPlugins(): Promise<PluginInfo[]> {
    const infos: PluginInfo[] = [];

    for (const [id, plugin] of this.plugins) {
      const availability = await plugin.checkAvailability();
      infos.push({
        id,
        name: plugin.manifest.name,
        version: plugin.manifest.version,
        description: plugin.manifest.description,
        capabilities: plugin.manifest.capabilities,
        available: availability.available,
        availabilityDetails: availability,
        settingsSchema: plugin.manifest.settingsSchema,
      });
    }

    return infos;
  }

  /**
   * Get a specific plugin
   */
  getPlugin(pluginId: string): Plugin | undefined {
    return this.plugins.get(pluginId);
  }

  /**
   * Check plugin availability
   */
  async checkAvailability(pluginId: string): Promise<ToolAvailability> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      return { available: false, error: `Plugin ${pluginId} not found` };
    }
    return plugin.checkAvailability();
  }

  /**
   * Get settings for a plugin
   */
  getSettings(pluginId: string): Record<string, unknown> {
    const saved = this.loadPluginSettings(pluginId);
    if (saved) return saved;

    // Return defaults from manifest
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return {};

    const defaults: Record<string, unknown> = {};
    for (const field of plugin.manifest.settingsSchema) {
      defaults[field.key] = field.default;
    }
    return defaults;
  }

  /**
   * Update settings for a plugin
   * Returns array of validation errors (empty if valid)
   */
  updateSettings(pluginId: string, settings: Record<string, unknown>): string[] {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      return [`Plugin ${pluginId} not found`];
    }

    // Validate settings against schema
    const errors = this.validateSettings(plugin, settings);
    if (errors.length > 0) {
      return errors;
    }

    // Save settings
    this.savePluginSettings(pluginId, settings);

    // Notify plugin
    if (plugin.onSettingsChanged) {
      plugin.onSettingsChanged(settings);
    }

    return [];
  }

  /**
   * Emit progress event to renderer
   */
  emitProgress(progress: PluginProgress): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('plugin:progress', progress);
    }
  }

  /**
   * Dispose all plugins (called on app shutdown)
   */
  async disposeAll(): Promise<void> {
    for (const [id] of this.plugins) {
      await this.unregister(id);
    }
  }

  // Private methods

  private registerIpcHandlers(plugin: Plugin): void {
    const pluginId = plugin.manifest.id;

    for (const { channel, handler } of plugin.getIpcHandlers()) {
      const fullChannel = `plugin:${pluginId}:${channel}`;
      console.log(`  Registering IPC handler: ${fullChannel}`);
      ipcMain.handle(fullChannel, handler);
    }
  }

  private validateSettings(plugin: Plugin, settings: Record<string, unknown>): string[] {
    const errors: string[] = [];

    for (const field of plugin.manifest.settingsSchema) {
      const value = settings[field.key];

      // Check required fields (if no default and not provided)
      if (value === undefined && field.default === undefined) {
        errors.push(`${field.label} is required`);
        continue;
      }

      // Skip validation if using default
      if (value === undefined) continue;

      // Type validation
      switch (field.type) {
        case 'number':
          if (typeof value !== 'number') {
            errors.push(`${field.label} must be a number`);
          } else {
            if (field.min !== undefined && value < field.min) {
              errors.push(`${field.label} must be at least ${field.min}`);
            }
            if (field.max !== undefined && value > field.max) {
              errors.push(`${field.label} must be at most ${field.max}`);
            }
          }
          break;

        case 'boolean':
          if (typeof value !== 'boolean') {
            errors.push(`${field.label} must be a boolean`);
          }
          break;

        case 'select':
          if (field.options && !field.options.some(o => o.value === value)) {
            errors.push(`${field.label} has invalid value`);
          }
          break;

        case 'string':
        case 'path':
          if (typeof value !== 'string') {
            errors.push(`${field.label} must be a string`);
          }
          break;
      }
    }

    return errors;
  }

  private loadPluginSettings(pluginId: string): Record<string, unknown> | null {
    const filePath = path.join(this.settingsDir, `${pluginId}.json`);

    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(content);
      }
    } catch (err) {
      console.error(`Failed to load settings for ${pluginId}:`, err);
    }

    return null;
  }

  private savePluginSettings(pluginId: string, settings: Record<string, unknown>): void {
    try {
      // Ensure directory exists
      fs.mkdirSync(this.settingsDir, { recursive: true });

      const filePath = path.join(this.settingsDir, `${pluginId}.json`);
      fs.writeFileSync(filePath, JSON.stringify(settings, null, 2));
    } catch (err) {
      console.error(`Failed to save settings for ${pluginId}:`, err);
    }
  }
}

// Export singleton getter
export function getPluginRegistry(): PluginRegistry {
  return PluginRegistry.getInstance();
}
