import * as fs from 'fs/promises';
import * as path from 'path';

// Cache loaded prompts to avoid repeated file reads
const promptCache = new Map<string, string>();

/**
 * Load a prompt from the prompts directory
 * @param promptName The name of the prompt file (without .txt extension)
 * @returns The prompt text content
 */
export async function loadPrompt(promptName: string): Promise<string> {
  // Check cache first
  if (promptCache.has(promptName)) {
    return promptCache.get(promptName)!;
  }

  try {
    // In the dist build, prompts are in the same directory as this module
    const promptPath = path.join(__dirname, 'prompts', `${promptName}.txt`);
    const content = await fs.readFile(promptPath, 'utf-8');

    // Cache the loaded prompt
    promptCache.set(promptName, content);

    return content;
  } catch (error) {
    console.error(`[PROMPTS] Failed to load prompt ${promptName}:`, error);
    throw new Error(`Prompt file not found: ${promptName}.txt`);
  }
}

/**
 * Clear the prompt cache (useful if prompts are edited during runtime)
 */
export function clearPromptCache(): void {
  promptCache.clear();
}

/**
 * Available prompt names
 */
export const PROMPTS = {
  LL_SIMPLIFY: 'll-simplify',
  LL_CLEANUP: 'll-cleanup',
  TTS_CLEANUP: 'tts-cleanup',
  TTS_CLEANUP_FULL: 'tts-cleanup-full',
  MONO_TRANSLATION: 'mono-translation'
} as const;