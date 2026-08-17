import { Injectable, signal } from '@angular/core';

/**
 * THE ONE SENTENCE THE WINDOW SAYS ABOUT ITSELF.
 *
 * A drop this app will not open, a save that failed, a step whose payload is a
 * container no viewer can show, a chord that could not do the thing it names.
 * Everything that goes wrong OUT HERE — rather than inside a document, where the
 * document's own surface says it — lands on one line under the window's chrome
 * and stays there until somebody dismisses it. Never on a timer: a refusal that
 * vanished by itself is a refusal the user gets to wonder about afterwards.
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
 * ONE LINE AND NOT A QUEUE. A second refusal replaces the first, deliberately —
 * a stack of grievances is a log, and a log in the chrome of a document app is a
 * thing people learn to stop reading. What matters is the most recent reason the
 * thing they just tried did not happen.
 */
@Injectable({ providedIn: 'root' })
export class NoticeService {
  /**
   * The sentence, or null for a window with nothing to apologise for.
   *
   * WRITABLE BY EVERYONE, on purpose. There is no `say()` wrapper because there
   * is nothing for one to do: no formatting, no history, no severity. The
   * dismissal is `set(null)` from the bar's own ✕, which is the only reader that
   * writes.
   */
  readonly notice = signal<string | null>(null);
}
