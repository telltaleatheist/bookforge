/**
 * Which voices a narration run can be rendered in.
 *
 * ── Why this is a service and not two lists ─────────────────────────────────
 *
 * The Process page has always owned this catalog: two seeded lists, one replaced
 * at startup by the voices actually installed, the other extended by whatever
 * custom Orpheus models are sitting in the models folder. The TTS copy's Process
 * modal offers the same choice over the same file, and a second copy of the
 * catalog is a second answer to "what voices are there" — the shape of an offer
 * for a voice whose reference clip is no longer on disk, which is the exact bug
 * the runtime load replaced a hardcoded list to fix.
 *
 * So the catalog lives here, once, loaded once per app, and both doors read it.
 * `provideIn: 'root'` because it describes the MACHINE — what is installed —
 * rather than anything about a book, so two windows asking is one answer.
 *
 * ── The seeds are not fallbacks ─────────────────────────────────────────────
 *
 * They are what BookForge ships with. `load()` REPLACES the XTTS list when main
 * answers with installed voices, and appends discovered Orpheus models to the
 * built-ins; an unanswered call leaves the shipped list, which is a true
 * statement about a build whose extra voices have not been downloaded. What it
 * must never do is offer a voice that is not there, and that is why the XTTS
 * list is replaced rather than merged.
 */
import { Injectable, computed, inject, signal } from '@angular/core';
import { ComponentService } from '../../../core/services/component.service';

export interface NarrationVoice {
  readonly value: string;
  readonly label: string;
}

@Injectable({ providedIn: 'root' })
export class NarrationVoicesService {
  private readonly components = inject(ComponentService);

  /**
   * The XTTS-family voices. Seeded with what the app ships and replaced by the
   * installed set the moment main answers.
   */
  private readonly xtts = signal<readonly NarrationVoice[]>([
    { value: 'internal', label: 'Default XTTS' },
    { value: 'ScarlettJohansson', label: 'Scarlett Johansson' },
  ]);

  /**
   * Orpheus voices, ordered best → worst prosody (user-ranked), accent in the
   * label. Custom models discovered in the models folder are appended by
   * `load()` and marked so they are distinguishable from the built-ins.
   */
  private readonly orpheus = signal<readonly NarrationVoice[]>([
    { value: 'leah', label: 'Leah (Female, American)' },
    { value: 'tara', label: 'Tara (Female, American)' },
    { value: 'zoe', label: 'Zoe (Female, American)' },
    { value: 'mia', label: 'Mia (Female, American)' },
    { value: 'jess', label: 'Jess (Female, American)' },
    { value: 'zac', label: 'Zac (Male, American)' },
    { value: 'dan', label: 'Dan (Male, Cockney)' },
    { value: 'leo', label: 'Leo (Male, American)' },
  ]);

  /** Done once per app: the machine does not grow voices while a modal is open. */
  private loaded = false;

  readonly xttsVoices = computed(() => this.xtts());
  readonly orpheusVoices = computed(() => this.orpheus());

  /** The voices THIS engine can be asked for. */
  voicesFor(engine: string): readonly NarrationVoice[] {
    return engine === 'orpheus' ? this.orpheus() : this.xtts();
  }

  /** The installed RVC enhancement models, as the enhancement picker lists them. */
  readonly rvcVoices = computed<readonly NarrationVoice[]>(() =>
    this.components.components()
      .filter((c) => c.component.kind === 'rvc-model' && c.state === 'installed')
      .map((c) => ({ value: c.component.id, label: c.component.name })),
  );

  /** What an RVC voice id is called, or the id when the model is not installed. */
  rvcVoiceLabel(voiceId: string): string {
    return this.rvcVoices().find((v) => v.value === voiceId)?.label || voiceId;
  }

  /**
   * Ask main what is actually installed.
   *
   * Silent on failure by design, and it is not a swallowed error: the seeded
   * lists are real voices this build ships with, so a machine that cannot answer
   * still offers a working choice. Callers `void` this — it is a refinement of
   * an already-correct list, never a gate on showing the picker.
   */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    await Promise.all([this.loadXtts(), this.loadOrpheus()]);
  }

  private async loadXtts(): Promise<void> {
    try {
      const api = (window as any).electron?.customVoices;
      if (!api?.listAudiobook) return;
      const res = await api.listAudiobook();
      if (res?.success && Array.isArray(res.data) && res.data.length > 0) {
        this.xtts.set(res.data as NarrationVoice[]);
      }
    } catch {
      /* keep the shipped options — see the header */
    }
  }

  private async loadOrpheus(): Promise<void> {
    try {
      const api = (window as any).electron?.orpheusModels;
      const res = await api?.list();
      if (!res?.success || !res.data?.length) return;
      const custom: NarrationVoice[] = res.data.map(
        (m: { id: string; label: string }) => ({ value: m.id, label: `${m.label} (Custom)` }),
      );
      // A custom folder of the same name IS that voice now, so the built-in it
      // collides with is dropped rather than listed twice.
      const customValues = new Set(custom.map((c) => c.value));
      const builtins = this.orpheus().filter((v) => !customValues.has(v.value));
      this.orpheus.set([...builtins, ...custom]);
    } catch {
      /* keep the built-ins — see the header */
    }
  }
}
