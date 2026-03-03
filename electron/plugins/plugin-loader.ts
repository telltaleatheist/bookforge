/**
 * Plugin Loader - Loads built-in plugins on app startup
 */

import { PluginRegistry } from './plugin-registry';
import { SuryaOcrPlugin } from './builtin/surya-ocr/surya-ocr-plugin';
import { AppleVisionOcrPlugin } from './builtin/apple-vision-ocr/apple-vision-ocr-plugin';
import { PaddleOcrPlugin } from './builtin/paddle-ocr/paddle-ocr-plugin';

/**
 * Load all built-in plugins
 */
export async function loadBuiltinPlugins(registry: PluginRegistry): Promise<void> {
  console.log('Loading built-in plugins...');

  // OCR plugins
  await registry.register(new SuryaOcrPlugin());
  await registry.register(new AppleVisionOcrPlugin());
  await registry.register(new PaddleOcrPlugin());

  // Future: ebook2audiobook plugin
  // await registry.register(new Ebook2AudiobookPlugin());

  console.log('Built-in plugins loaded');
}
