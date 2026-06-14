/**
 * Official per-OS installer downloads for external tools (Calibre, Tesseract, …).
 *
 * These tools can't be silently installed (they need their own OS installer +
 * the elevation prompt), but we can fetch the right one for the user's platform
 * and launch it — far simpler than "here are install instructions". After the OS
 * installer finishes, the component system's normal detection (or Locate) picks
 * the tool up. Kept separate from the locked OptionalComponent contract.
 *
 * URLs are the vendors' stable channels where possible:
 *  - Calibre publishes a "latest" redirect at calibre-ebook.com/dist/{win64,osx}.
 *  - Tesseract (Windows) uses the UB-Mannheim build (no "latest" alias, so pinned).
 */

export interface ExternalInstaller {
  url: string;
  /** Temp filename — the extension matters for how the OS launches it. */
  filename: string;
  /**
   * 'run'  → the file IS the installer (exe/msi/pkg); opening it starts the wizard.
   * 'open' → a disk image (dmg) the user drags into Applications themselves.
   */
  action: 'run' | 'open';
  /** Short guidance shown after launch (esp. for 'open'/dmg). */
  note?: string;
}

const INSTALLERS: Record<string, Partial<Record<NodeJS.Platform, ExternalInstaller>>> = {
  calibre: {
    win32: {
      url: 'https://calibre-ebook.com/dist/win64',
      filename: 'calibre-setup.msi',
      action: 'run',
    },
    darwin: {
      url: 'https://calibre-ebook.com/dist/osx',
      filename: 'calibre.dmg',
      action: 'open',
      note: 'Drag Calibre into your Applications folder, then click Locate.',
    },
  },
  tesseract: {
    win32: {
      url: 'https://digi.bib.uni-mannheim.de/tesseract/tesseract-ocr-w64-setup-5.4.0.20240606.exe',
      filename: 'tesseract-setup.exe',
      action: 'run',
    },
    // macOS/Linux Tesseract ship via package managers (brew/apt) with no
    // standalone installer, so they fall back to Locate / instructions.
  },
};

export function getExternalInstaller(
  id: string,
  platform: NodeJS.Platform = process.platform,
): ExternalInstaller | null {
  return INSTALLERS[id]?.[platform] ?? null;
}

/** Component ids that have a downloadable installer for this platform. */
export function installableExternalIds(platform: NodeJS.Platform = process.platform): string[] {
  return Object.keys(INSTALLERS).filter((id) => !!INSTALLERS[id][platform]);
}
