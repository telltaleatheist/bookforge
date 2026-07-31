/**
 * Just enough @angular/core to construct a renderer service outside Angular.
 *
 * export.service.ts is a renderer service, so the EPUB generator cannot be
 * reached over IPC the way cli/ocr-pdf.js reaches the OCR path — there is no
 * main-process copy to call. The alternative would be reimplementing the
 * generator in the CLI, which is exactly the parallel implementation this
 * repo's CLI rule forbids: a CLI that runs its own copy proves nothing about
 * the app.
 *
 * So the real class is bundled and constructed here instead. Its three injected
 * dependencies (PdfService, Router, ElectronService) are used only by the
 * save/download wrappers — `generateEpubBlobInternal` and the zip writer touch
 * none of them — so an inert stub is enough to build the object.
 *
 * Two different strictnesses on purpose:
 *   - `inject()` returns a proxy that THROWS on any use, so if the generator
 *     ever starts reaching a real dependency the CLI says so instead of quietly
 *     producing a different book than the app would.
 *   - everything else (ɵɵFactoryTarget, ɵɵdefineInjectable and the rest of the
 *     compiled-decorator surface, which arrives via the import graph) resolves
 *     to something inert, because those are Angular's own bookkeeping and have
 *     no bearing on what the generator emits.
 */
'use strict';

const DEAD = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'then' || prop === Symbol.toPrimitive) return undefined;
    throw new Error(
      `cli/export-epub: the EPUB generator reached an injected Angular dependency ` +
      `('${String(prop)}'). Only the download/save wrappers are supposed to do that, ` +
      `so either the code path changed or the CLI is driving the wrong method.`);
  },
});

const noop = function () { return undefined; };
const decorator = () => (target) => target;

const explicit = {
  inject: () => DEAD,
  Injectable: decorator,
  Component: decorator,
  Directive: decorator,
  Pipe: decorator,
  NgModule: decorator,
  Optional: decorator,
  Inject: decorator,
  Host: decorator,
  Self: decorator,
  SkipSelf: decorator,
  InjectionToken: class InjectionToken { constructor(desc) { this._desc = desc; } },
  ɵɵFactoryTarget: { Directive: 0, Component: 1, Injectable: 2, Pipe: 3, NgModule: 4 },
  signal(initial) {
    let v = initial;
    const s = () => v;
    s.set = (next) => { v = next; };
    s.update = (fn) => { v = fn(v); };
    s.asReadonly = () => s;
    return s;
  },
  computed: (fn) => fn,
  effect: noop,
  input: Object.assign(() => noop, { required: () => noop }),
  output: () => ({ emit: noop, subscribe: noop }),
  ChangeDetectionStrategy: { OnPush: 0, Default: 1 },
  ViewChild: decorator,
  ElementRef: class ElementRef {},
};

// Anything not named above is Angular bookkeeping pulled in by the import graph.
// Return an inert callable so both `X()` and `X.Y` resolve without exploding.
module.exports = new Proxy(explicit, {
  get(target, prop) {
    if (prop in target) return target[prop];
    if (prop === '__esModule') return true;
    if (typeof prop === 'symbol') return undefined;
    const inert = function () { return inert; };
    return new Proxy(inert, {
      get(_t, p) { return p === Symbol.toPrimitive ? undefined : inert; },
      apply() { return inert; },
      construct() { return {}; },
    });
  },
});
