import { Injectable, inject, signal, OnDestroy } from '@angular/core';
import { ElectronService } from './electron.service';
import { SettingsService, SettingsSection, SettingField } from './settings.service';

/**
 * Plugin info from main process
 */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  capabilities: string[];
  available: boolean;
  availabilityDetails?: {
    available: boolean;
    version?: string;
    path?: string;
    error?: string;
    installInstructions?: string;
  };
  settingsSchema: SettingField[];
}

/**
 * Progress event from plugin operations
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
 * PluginService - Manages plugins from Angular
 *
 * Provides:
 * - List available plugins
 * - Check plugin availability
 * - Get/set plugin settings
 * - Invoke plugin operations
 * - Subscribe to progress events
 */
@Injectable({
  providedIn: 'root'
})
export class PluginService implements OnDestroy {
  private readonly electron = inject(ElectronService);
  private readonly settingsService = inject(SettingsService);

  // List of all plugins
  readonly plugins = signal<PluginInfo[]>([]);

  // Loading state
  readonly loading = signal(false);

  // Progress events
  readonly progress = signal<PluginProgress | null>(null);

  // Unsubscribe function for progress listener
  private progressUnsubscribe: (() => void) | null = null;

  constructor() {
    this.setupProgressListener();
    this.loadPlugins();
  }

  ngOnDestroy(): void {
    if (this.progressUnsubscribe) {
      this.progressUnsubscribe();
    }
  }

  /**
   * Set up listener for plugin progress events
   */
  private setupProgressListener(): void {
    if (!this.electron.isRunningInElectron) return;

    this.progressUnsubscribe = (window as any).electron.plugins.onProgress((progress: PluginProgress) => {
      this.progress.set(progress);
    });
  }

  /**
   * Load list of plugins from main process
   */
  async loadPlugins(): Promise<void> {
    if (!this.electron.isRunningInElectron) {
      this.plugins.set([]);
      return;
    }

    this.loading.set(true);

    try {
      const result = await (window as any).electron.plugins.list();
      if (result.success && result.data) {
        this.plugins.set(result.data);

        // Register plugin settings sections
        for (const plugin of result.data) {
          this.registerPluginSettings(plugin);
        }
      }
    } catch (err) {
      console.error('Failed to load plugins:', err);
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Register a plugin's settings in the settings service
   */
  private registerPluginSettings(plugin: PluginInfo): void {
    if (!plugin.settingsSchema || plugin.settingsSchema.length === 0) return;

    const section: SettingsSection = {
      id: `plugin-${plugin.id}`,
      name: plugin.name,
      description: plugin.description,
      icon: this.getPluginIcon(plugin),
      fields: plugin.settingsSchema,
      isPlugin: true,
    };

    this.settingsService.registerPluginSection(section);
  }

  /**
   * Get icon for plugin based on capabilities
   */
  private getPluginIcon(plugin: PluginInfo): string {
    if (plugin.capabilities.includes('ocr')) return '🔤';
    if (plugin.capabilities.includes('tts')) return '🔊';
    if (plugin.capabilities.includes('export')) return '📤';
    return '🔌';
  }

  /**
   * Get a specific plugin by ID
   */
  getPlugin(pluginId: string): PluginInfo | undefined {
    return this.plugins().find(p => p.id === pluginId);
  }

  /**
   * Get plugins by capability
   */
  getPluginsByCapability(capability: string): PluginInfo[] {
    return this.plugins().filter(p =>
      p.capabilities.includes(capability) && p.available
    );
  }

  /**
   * Check if a plugin is available
   */
  async checkAvailability(pluginId: string): Promise<{
    available: boolean;
    version?: string;
    error?: string;
    installInstructions?: string;
  }> {
    if (!this.electron.isRunningInElectron) {
      return { available: false, error: 'Not running in Electron' };
    }

    try {
      const result = await (window as any).electron.plugins.checkAvailability(pluginId);
      if (result.success && result.data) {
        return result.data;
      }
      return { available: false, error: result.error };
    } catch (err) {
      return { available: false, error: (err as Error).message };
    }
  }

  /**
   * Get settings for a plugin
   */
  async getSettings(pluginId: string): Promise<Record<string, unknown>> {
    if (!this.electron.isRunningInElectron) {
      return {};
    }

    try {
      const result = await (window as any).electron.plugins.getSettings(pluginId);
      if (result.success && result.data) {
        return result.data;
      }
    } catch (err) {
      console.error(`Failed to get settings for ${pluginId}:`, err);
    }

    return {};
  }

  /**
   * Update settings for a plugin
   */
  async updateSettings(pluginId: string, settings: Record<string, unknown>): Promise<string[]> {
    if (!this.electron.isRunningInElectron) {
      return ['Not running in Electron'];
    }

    try {
      const result = await (window as any).electron.plugins.updateSettings(pluginId, settings);
      if (result.success) {
        return [];
      }
      return result.errors || [result.error || 'Unknown error'];
    } catch (err) {
      return [(err as Error).message];
    }
  }

  /**
   * Invoke a plugin operation
   */
  async invoke<T>(pluginId: string, channel: string, ...args: unknown[]): Promise<{
    success: boolean;
    data?: T;
    error?: string;
  }> {
    if (!this.electron.isRunningInElectron) {
      return { success: false, error: 'Not running in Electron' };
    }

    try {
      const result = await (window as any).electron.plugins.invoke(pluginId, channel, ...args);
      return result as { success: boolean; data?: T; error?: string };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Clear progress signal
   */
  clearProgress(): void {
    this.progress.set(null);
  }

  // ===== OCR-specific helpers =====

  /**
   * Get available OCR plugins
   */
  getOcrPlugins(): PluginInfo[] {
    return this.getPluginsByCapability('ocr');
  }

  /**
   * Text line with bounding box from OCR
   */


  /**
   * Run OCR on an image using a specific plugin
   */
  async runOcr(pluginId: string, imageData: string): Promise<{
    success: boolean;
    text?: string;
    confidence?: number;
    textLines?: Array<{ text: string; confidence: number; bbox: [number, number, number, number] }>;
    error?: string;
  }> {
    const result = await this.invoke<{
      text: string;
      confidence: number;
      textLines?: Array<{ text: string; confidence: number; bbox: [number, number, number, number] }>;
    }>(
      pluginId,
      'recognize',
      imageData
    );

    if (result.success && result.data) {
      return {
        success: true,
        text: result.data.text,
        confidence: result.data.confidence,
        textLines: result.data.textLines,
      };
    }

    return { success: false, error: result.error };
  }

  /**
   * Run batch OCR on multiple images
   */
  async runOcrBatch(pluginId: string, images: string[], pageNumbers: number[]): Promise<{
    success: boolean;
    pages?: Array<{
      page: number;
      text: string;
      textLines?: Array<{ text: string; confidence: number; bbox: [number, number, number, number] }>;
    }>;
    error?: string;
  }> {
    const result = await this.invoke<Array<{
      page: number;
      text: string;
      textLines?: Array<{ text: string; confidence: number; bbox: [number, number, number, number] }>;
    }>>(
      pluginId,
      'recognize-batch',
      images,
      pageNumbers
    );

    if (result.success && result.data) {
      return {
        success: true,
        pages: result.data,
      };
    }

    return { success: false, error: result.error };
  }

  /**
   * Run OCR with layout detection (Surya only)
   * Returns both text lines and semantic layout blocks
   */
  async runOcrWithLayout(pluginId: string, imageData: string): Promise<{
    success: boolean;
    text?: string;
    confidence?: number;
    textLines?: Array<{ text: string; confidence: number; bbox: [number, number, number, number] }>;
    layoutBlocks?: PluginLayoutBlock[];
    error?: string;
  }> {
    const result = await this.invoke<{
      text: string;
      confidence: number;
      textLines?: Array<{ text: string; confidence: number; bbox: [number, number, number, number] }>;
      layoutBlocks?: PluginLayoutBlock[];
    }>(
      pluginId,
      'recognize-with-layout',
      imageData
    );

    if (result.success && result.data) {
      return {
        success: true,
        text: result.data.text,
        confidence: result.data.confidence,
        textLines: result.data.textLines,
        layoutBlocks: result.data.layoutBlocks,
      };
    }

    return { success: false, error: result.error };
  }

  /**
   * Detect layout only (no OCR) - returns semantic regions
   */
  async detectLayout(pluginId: string, imageData: string): Promise<{
    success: boolean;
    layoutBlocks?: PluginLayoutBlock[];
    error?: string;
  }> {
    const result = await this.invoke<PluginLayoutBlock[]>(
      pluginId,
      'detect-layout',
      imageData
    );

    if (result.success && result.data) {
      return {
        success: true,
        layoutBlocks: result.data,
      };
    }

    return { success: false, error: result.error };
  }
}

/**
 * Layout block from Surya layout detection
 */
export interface PluginLayoutBlock {
  bbox: [number, number, number, number];
  polygon: number[][];
  label: string;
  confidence: number;
  position: number;
  text?: string;
}
