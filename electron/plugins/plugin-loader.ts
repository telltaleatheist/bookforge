/**
 * Plugin Loader - Loads built-in plugins on app startup
 */

import { PluginRegistry } from './plugin-registry';

/**
 * Load all built-in plugins
 */
export async function loadBuiltinPlugins(registry: PluginRegistry): Promise<void> {
  console.log('Loading built-in plugins...');

  /*
   * NO BUILT-IN PLUGINS (2026-09-17). Apple Vision OCR was the only one, and
   * Owen retired it with the rest of the OCR layer: "apple vision and its
   * settings page can be removed". Like Tesseract, it was REGISTERED and called
   * by nothing — the pages are read by the document vision model now.
   *
   * The registry and the loader stay. They are the seam a plugin arrives
   * through, and an empty list is a true statement about this build rather than
   * a missing mechanism.
   */

  console.log('Built-in plugins loaded');
}
