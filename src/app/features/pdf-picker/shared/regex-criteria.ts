/**
 * regex-criteria — the shape of a "select by pattern" request.
 *
 * The picker's Select mode builds one of these and hands it to the matcher; it
 * is one object rather than the ~14 individual form signals the shell used to
 * round-trip, so a criteria is passed, stored and reset as a value.
 *
 * It lived inside `components/regex-category-builder/` until Aug 2026, beside a
 * panel component that drew a form for it. That component became unreachable
 * when the picker became one screen — not in the shell's `imports`, its selector
 * in no template — while these two declarations stayed live. So the component
 * went and the shape moved here, where the code that uses it can find it
 * without importing a 959-line dead panel to get at a type.
 */

export interface RegexCriteria {
  name: string;
  pattern: string;
  color: string;
  minFontSize: number;
  /** 0 means "no max filter". */
  maxFontSize: number;
  minBaseline: number | null;
  maxBaseline: number | null;
  caseSensitive: boolean;
  /** When true, special regex chars in the pattern are escaped (literal search). */
  literalMode: boolean;
  /** Category IDs to include. Empty = none (matches nothing). */
  categoryFilter: string[];
  pageFilterType: 'all' | 'range' | 'even' | 'odd' | 'specific';
  pageRangeStart: number;
  pageRangeEnd: number;
  specificPages: string;
}

/** Factory for a fresh, empty criteria (matches the shell's historic reset values). */
export function defaultRegexCriteria(): RegexCriteria {
  return {
    name: '',
    pattern: '',
    color: '#FF5722',
    minFontSize: 0,
    maxFontSize: 0,
    minBaseline: null,
    maxBaseline: null,
    caseSensitive: false,
    literalMode: false,
    categoryFilter: [],
    pageFilterType: 'all',
    pageRangeStart: 1,
    pageRangeEnd: 1,
    specificPages: '',
  };
}
