import { signal } from '@angular/core';

import type { FoundryApi } from '@shared/api';

declare global {
  interface Window {
    foundry?: FoundryApi;
  }
}

/**
 * The bridge, or nothing.
 *
 * Nothing happens when the renderer is opened in a plain browser (`ng serve`
 * without Electron): every service degrades to an empty list and a disabled
 * button rather than a white screen full of `undefined is not a function`.
 */
export const api: FoundryApi | null =
  typeof window !== 'undefined' && window.foundry ? window.foundry : null;

export const hasBridge = api !== null;

/**
 * Whether this window is standing inside another app (docs/BOOKFORGE-HANDOFF.md
 * §8) — false until main says otherwise, and main's answer cannot change while
 * the page lives, so a signal set once is the whole machinery.
 *
 * IT LIVES HERE RATHER THAN IN A SERVICE because it is the same kind of fact as
 * `hasBridge`, one line up: not chrome state, not a preference, but what kind
 * of process this page woke up inside. The moments that read it are scattered
 * across chrome that shares no other service — the dock's Home, Home's own
 * library list, the settings screen's library card — and each hides exactly one
 * thing: a second answer to a question the host already answers (§8: "two
 * library screens would be two answers to 'what books do I have'").
 *
 * FALSE FOR A BEAT ON STARTUP, hosted — the answer is a round trip away — which
 * shows standalone chrome for a frame before it hides. That is the right
 * direction to be briefly wrong in: a Home button that vanishes is furniture
 * settling; standalone chrome that FLICKERED IN on every launch because the
 * default was hosted would be the app doubting who it is.
 */
export const hosted = signal(false);

if (api !== null) {
  void api.hosted().then((answer) => hosted.set(answer));
}
