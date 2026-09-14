import { Injectable, signal } from '@angular/core';

import type { ActGate, ActGates, ActName } from '@shared/types';
import { api } from './foundry';

/**
 * THE MACHINE'S HALF OF WHETHER A TILE MAY BE PRESSED.
 *
 * Owen (docs/SLOTS.md §1): *"if their system just isnt powerful enough for
 * translation (smaller than 9b) then translation and simplify is disabled. the
 * tiles arent lit up until the models are present."* And: *"if a job is going to
 * take an obscenely long time, like translation on cpu, it should just be
 * disabled."*
 *
 * ── THERE ARE TWO GATES ON EVERY TILE AND THEY ANSWER DIFFERENT QUESTIONS ───
 *
 * `shared/stages.ts` answers *is there a book at this position for the act to be
 * aimed at* — a fact about the LEDGER, which lives out here, and which has not
 * changed. This service carries the other half: is there a model, does it fit,
 * is anything serving — facts about the MACHINE, every one of which lives in
 * main (act-gates.ts). A tile needs both, and the two are kept apart because
 * they say different things when they say no. A tooltip reading "there is no
 * book here" on a machine with no model would send somebody to open a book that
 * would not have helped.
 *
 * ── IT STARTS LIT, AND THAT IS DELIBERATE ───────────────────────────────────
 *
 * The first answer is one IPC round trip away, and a dock that drew five
 * disabled tiles for that moment and then enabled them would flicker on every
 * launch — and would be worse than flicker in the one case that matters, a
 * window whose bridge never arrives (`ng serve` with no electron behind it),
 * where every tile would be permanently and inexplicably gray. So the standing
 * value is "lit, with nothing to say", which is exactly how the app behaved
 * before this wave: the stage gate alone decides until main answers, and main
 * answers in milliseconds.
 *
 * ── AND IT RE-ASKS RATHER THAN BEING TOLD ───────────────────────────────────
 *
 * `acts:gates-changed` carries no payload (electron/ipc.ts argues why). Main
 * says the machine moved — a model pulled, the page reader installed or removed,
 * the language server repointed — and this asks again. One composer of the
 * shape, in main, and no pushed copy to go stale.
 */
const ALL_LIT: ActGates = {
  translate: { lit: true, why: '' },
  simplify: { lit: true, why: '' },
  analysis: { lit: true, why: '' },
  clean: { lit: true, why: '' },
  read: { lit: true, why: '' },
};

@Injectable({ providedIn: 'root' })
export class ActGatesService {
  private readonly state = signal<ActGates>(ALL_LIT);

  /** The whole answer, for a surface that wants more than one act. */
  readonly gates = this.state.asReadonly();

  constructor() {
    if (!api) return;
    void this.load();
    api.acts.onChanged(() => { void this.load(); });
  }

  /**
   * One act's answer.
   *
   * A METHOD RATHER THAN FIVE COMPUTED SIGNALS, because the template asks it by
   * name twice per tile — once for `[disabled]` and once for the title — and a
   * signal per act would be five declarations that differ only in a string.
   */
  gate(act: ActName): ActGate {
    return this.state()[act];
  }

  /**
   * Ask main again.
   *
   * PUBLIC, because a screen that has just done something main cannot see itself
   * — package E's Crucible connect, say — can say so. Nothing calls it that way
   * today; the push covers every door that exists.
   */
  async load(): Promise<void> {
    if (!api) return;
    /*
     * A FAILURE LEAVES THE LAST ANSWER STANDING, and on the first load that is
     * ALL_LIT. Darkening the whole dock because one IPC call rejected would be
     * this service reporting its own failure as the machine's incapacity, which
     * is a sentence nobody could act on.
     */
    try {
      this.state.set(await api.acts.gates());
    } catch (err) {
      console.error('[act-gates] the gates could not be read', err);
    }
  }
}
