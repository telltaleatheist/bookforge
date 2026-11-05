import { Injectable, computed, inject } from '@angular/core';

import { SettingsService } from './settings.service';

/**
 * Is AI available? A GPU engine (Crucible) has been chosen in Settings → AI; that is
 * the one provider this app has. The cleanup/simplify pages gate on `available()`.
 *
 * It asked two more questions once: whether a Claude or OpenAI key was saved and
 * Ollama was running (gone 2026-09-14: this app holds no key, and those are upstreams
 * the ENGINE forwards to), and whether the bundled llama.cpp had a model downloaded
 * (gone 2026-11-04, docs/REORG-PLAN.md B2: no model runs in BookForge).
 */

@Injectable({ providedIn: 'root' })
export class AiService {
  private readonly settings = inject(SettingsService);

  /**
   * A Crucible server has been chosen (Settings → AI).
   *
   * A SERVER, AND NOT ALSO A MODEL, SINCE 2026-09-17. It used to require both,
   * because the app stored a model id alongside the server — and that id was a
   * second owner of a decision the engine makes per capability class, which
   * won over the choice made on the AI page. The app stores no model now
   * (`CrucibleConfig.model` is a run-time stamp), so requiring one here would
   * report every correctly configured machine as unconfigured.
   *
   * Configured is not the same as reachable, and this says the weaker thing on
   * purpose: whether the model that class resolves to is resident is the
   * server's answer at run time, asked then and refused by name then — a banner
   * that polled a machine across the room to decide whether to say "ready"
   * would be stale by the time anyone read it.
   */
  readonly crucibleConfigured = computed(() => {
    const cfg = this.settings.getAIConfig();
    return !!cfg.crucible?.server?.trim();
  });

  /** A text act has somewhere to run. See {@link crucibleConfigured}. */
  readonly available = this.crucibleConfigured;
}
