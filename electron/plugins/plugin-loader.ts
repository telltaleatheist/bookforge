/**
 * Plugin Loader - Loads built-in plugins on app startup
 */

import { PluginRegistry } from './plugin-registry';
import { SuryaOcrPlugin } from './builtin/surya-ocr/surya-ocr-plugin';

/**
 * Load all built-in plugins
 */
export async function loadBuiltinPlugins(registry: PluginRegistry): Promise<void> {
  console.log('Loading built-in plugins...');

  // Surya OCR plugin
  await registry.register(new SuryaOcrPlugin());

  // Future: ebook2audiobook plugin
  // await registry.register(new Ebook2AudiobookPlugin());

  console.log('Built-in plugins loaded');
}
