import { Injectable, inject, computed } from '@angular/core';
import { ComponentService } from './component.service';
import { ComponentStatus } from './electron.service';

/**
 * Renderer-side view of installed Stanza language packs, mirroring AiService's
 * role for AI providers. The pipeline (cleanup/translation) segments text
 * per-language with Stanza, so a language whose pack isn't present can't be
 * cleaned or translated offline — this service lets steps gate on availability
 * and offer a one-click download, the same way the cleanup step gates on AI.
 *
 * Language packs are ordinary 'language-pack' OptionalComponents (id
 * `stanza-<code>`); this is a thin domain wrapper over ComponentService so
 * callers think in ISO 639-1 codes ('de', 'ko') instead of component ids.
 */
@Injectable({ providedIn: 'root' })
export class LanguagePackService {
  private readonly components = inject(ComponentService);

  constructor() {
    void this.components.ensureLoaded();
  }

  /** True once the component catalog has loaded at least once. */
  readonly checkedOnce = computed(() => this.components.components().length > 0);

  /** ISO 639-1 codes whose Stanza pack is installed (bundled or downloaded). */
  readonly installedCodes = computed(() => {
    const codes = new Set<string>();
    for (const c of this.components.components()) {
      if (c.component.kind === 'language-pack' && c.state === 'installed') {
        codes.add(this.codeOf(c.component.id));
      }
    }
    return codes;
  });

  componentId(code: string): string {
    return `stanza-${code}`;
  }

  private codeOf(id: string): string {
    return id.startsWith('stanza-') ? id.slice('stanza-'.length) : id;
  }

  isInstalled(code: string): boolean {
    return this.installedCodes().has(code);
  }

  isBusy(code: string): boolean {
    return this.components.isBusy(this.componentId(code));
  }

  /** The catalog status for a language's pack, or null if no pack is offered. */
  statusFor(code: string): ComponentStatus | null {
    const id = this.componentId(code);
    return this.components.components().find(c => c.component.id === id) ?? null;
  }

  install(code: string): Promise<void> {
    return this.components.install(this.componentId(code));
  }

  cancel(code: string): Promise<void> {
    return this.components.cancel(this.componentId(code));
  }
}
