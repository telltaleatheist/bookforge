/**
 * unstated — how a Crucible fact the server did not send is SHOWN.
 *
 * Since Crucible 1.0.25 the SDK reads an informational field a server left out
 * as `null` ("it did not say") instead of refusing the whole document. Owen,
 * 2026-09-24: *"dont require any particular crucible server. if it can make the
 * call to the crucible server then it should work."* So a log line or a label
 * that names such a field has to be able to say that nothing was stated —
 * honestly, and the same way everywhere — rather than each site inventing an
 * empty string or a zero that reads as a real answer.
 *
 * FOR DISPLAY ONLY. A null that a DECISION depends on is decided where the
 * decision is made (a documented default or a named refusal), never smoothed
 * over with this.
 */

/** The literal shown in place of a fact the server did not state. */
export const UNSTATED = '(not stated)';

/** A fact for a log line or a label: itself, or {@link UNSTATED}. */
export function stated(value: string | number | boolean | null): string {
  return value === null ? UNSTATED : String(value);
}
