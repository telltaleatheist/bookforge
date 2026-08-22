import { Injectable, signal } from '@angular/core';

/**
 * THE ONE SENTENCE THE WINDOW SAYS ABOUT ITSELF.
 *
 * A drop this app will not open, a save that failed, a step whose payload is a
 * container no viewer can show, a chord that could not do the thing it names.
 * Everything that goes wrong OUT HERE — rather than inside a document, where the
 * document's own surface says it — lands on this signal and is drawn as a card in
 * the bottom-right corner of the window (`ToastTrayComponent`).
 *
 * ── Why it is a service of its own, which is the whole of unit 8c's first move ─
 *
 * It was one signal on `TabsService`, and HALF THE WINDOW injected that entire
 * class to reach it. The export dialog, the translate dialog, the simplify
 * dialog, the queue shelf, the library panel, the book viewer and the notice bar
 * itself all wanted to say one sentence, and every one of them took a dependency
 * on the flat tab list, the opening doors, the closing questions and the position
 * effects to do it. That is not a cost in bytes — it is a cost in what a reader
 * can conclude: a component that injects the documents service looks like a
 * component that opens and closes documents, and seven of them did not.
 *
 * SO IT DEPENDS ON NOTHING, and that is the point rather than an accident. It is
 * the bottom of the dependency chain the split establishes (Notice ← Documents ←
 * Stage ← PositionSync, docs/PLAN.md §4 unit 8c): anything in this app may say a
 * sentence, and saying one can never drag a graph of services in behind it.
 *
 * ── THE SIGNAL IS A DOORWAY AND NOT A PLACE: consume-and-reset ───────────────
 *
 * This used to be the value a bar along the top of the window DREW, and a second
 * refusal replaced the first — deliberately, on the argument that a stack of
 * grievances is a log. What that actually produced was a sentence deleted before
 * anybody had read it, silently, with nothing on screen to say a first one had
 * existed: batch work in this app raises two notices in a breath more often than
 * it raises one. It also meant the SAME sentence twice was invisible, because
 * setting a signal to the string it already holds is not a change.
 *
 * SO THE READER EMPTIES THE DOOR BEHIND ITSELF. There is exactly one reader —
 * `ToastTrayComponent` — and its contract is: on a non-null value, copy the
 * sentence into its own stack of cards and `set(null)` in the same turn. The
 * signal therefore holds a sentence for the length of one effect and is empty
 * again. Nobody else may read it, and nobody has to: stacking, ordering and the
 * lifetime of a card are the tray's business, and every writer's job is one
 * `set` of one string, exactly as it has always been.
 *
 * NOT ONE CALL SITE CHANGED when the bar became a tray, which is the argument
 * for having kept the door this plain in the first place.
 */
@Injectable({ providedIn: 'root' })
export class NoticeService {
  /**
   * The sentence, or null for a window with nothing to apologise for.
   *
   * WRITABLE BY EVERYONE, on purpose. There is no `say()` wrapper because there
   * is nothing for one to do: no formatting, no history, no severity.
   *
   * THE OTHER `set(null)` IS THE TRAY'S, one turn after it reads a sentence —
   * the consume-and-reset contract above. It is not a dismissal: the card the
   * tray raised outlives the value here by eight seconds or by however long
   * somebody keeps a pointer on it, and the ✕ on that card is the tray's own
   * business now.
   *
   * NO SEVERITY, and the tray therefore draws a refusal exactly as it draws a
   * confirmation — same card, same eight seconds. That cost is named in full in
   * `ToastTrayComponent`'s docblock, along with what adding a level here would
   * fix. It is deferred, not forgotten.
   */
  readonly notice = signal<string | null>(null);
}
