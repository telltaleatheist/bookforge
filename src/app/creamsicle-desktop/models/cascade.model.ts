// ============================================================================
// CREAMSICLE DESKTOP - Cascade List Models
// ============================================================================

/**
 * Individual item in a cascade list
 */
export interface CascadeItem {
  id: string;
  name: string;
  subtitle?: string;
  icon?: string;
  status?: 'pending' | 'active' | 'complete' | 'error';
  progress?: number;
  metadata?: string;
  tags?: string[];
  data?: unknown;
}

/**
 * Group of items with collapsible header
 */
export interface CascadeGroup {
  label: string;
  items: CascadeItem[];
  expanded?: boolean;
}

/**
 * Progress indicator state
 */
export interface ItemProgress {
  value: number;
  color?: string;
  label?: string;
  indeterminate?: boolean;
}

/**
 * Context menu action
 */
export interface ContextMenuAction {
  label: string;
  icon: string;
  action: string;
  divider?: boolean;
  disabled?: boolean;
  shortcut?: string;
}

/**
 * Context menu position
 */
export interface ContextMenuPosition {
  x: number;
  y: number;
}

/**
 * Selection change event
 */
export interface SelectionChangeEvent {
  count: number;
  ids: Set<string>;
}

/**
 * Item action event
 */
export interface ItemActionEvent {
  action: string;
  items: CascadeItem[];
}
