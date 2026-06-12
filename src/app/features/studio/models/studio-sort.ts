/**
 * Shared sort logic for the Studio collection.
 *
 * Both the Browse grid (library) and the Workspace list order items through
 * sortStudioItems(), so the two views always agree. The chosen preference is
 * owned by StudioService and persisted, so it survives reloads and library
 * switches.
 */

import { StudioItem } from './studio.types';

export type SortField = 'custom' | 'title' | 'modified' | 'created';
export type SortDirection = 'asc' | 'desc';

export interface SortPreference {
  field: SortField;
  direction: SortDirection;
}

/** Most-recently-modified first — what the user sees on a fresh install. */
export const DEFAULT_SORT: SortPreference = { field: 'modified', direction: 'desc' };

/** The direction that reads most naturally when a field is first selected. */
export function defaultDirectionFor(field: SortField): SortDirection {
  return field === 'title' ? 'asc' : 'desc';
}

const time = (iso?: string): number => (iso ? new Date(iso).getTime() || 0 : 0);

/**
 * Return a sorted copy of `items` (never mutates the input — important for
 * signal-derived arrays).
 *
 * 'custom' is the manual drag order: items the user has never dragged (no
 * sortOrder) float to the top by most-recently-modified, so freshly added or
 * just-finished items land first; everything else follows its saved sortOrder.
 * Direction does not apply to 'custom'.
 */
export function sortStudioItems(items: StudioItem[], pref: SortPreference): StudioItem[] {
  const copy = [...items];
  const dir = pref.direction === 'asc' ? 1 : -1;

  switch (pref.field) {
    case 'title':
      copy.sort((a, b) =>
        dir * (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base', numeric: true })
      );
      break;
    case 'created':
      copy.sort((a, b) => dir * (time(a.createdAt) - time(b.createdAt)));
      break;
    case 'modified':
      copy.sort((a, b) => dir * (time(a.modifiedAt) - time(b.modifiedAt)));
      break;
    case 'custom':
      copy.sort((a, b) => {
        const aHas = a.sortOrder !== undefined;
        const bHas = b.sortOrder !== undefined;
        if (!aHas && !bHas) return time(b.modifiedAt) - time(a.modifiedAt);
        if (!aHas) return -1;  // never-dragged items float to the top
        if (!bHas) return 1;
        return a.sortOrder! - b.sortOrder!;
      });
      break;
  }
  return copy;
}
