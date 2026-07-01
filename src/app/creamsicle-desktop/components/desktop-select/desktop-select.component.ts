import {
  Component,
  Input,
  Output,
  EventEmitter,
  forwardRef,
  signal,
  computed,
  ElementRef,
  ViewChild,
  ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { OverlayModule, CdkOverlayOrigin, ConnectedPosition } from '@angular/cdk/overlay';

export type DesktopSelectSize = 'sm' | 'md' | 'lg';

/** A single selectable option. `value` may be a string, number, boolean, or null. */
export interface DesktopSelectOption {
  value: any;
  label: string;
  disabled?: boolean;
  /**
   * Optional trailing text pinned to the right edge. Unlike the label (which
   * truncates with an ellipsis when space is tight), the badge is never
   * truncated — use it for information that must always stay visible, e.g. a
   * change count next to a long, ellipsis-able title.
   */
  badge?: string;
}

/** A labelled group of options (renders like an <optgroup>). */
export interface DesktopSelectOptionGroup {
  label: string;
  options: DesktopSelectOption[];
}

export type DesktopSelectItems = (DesktopSelectOption | DesktopSelectOptionGroup)[];

interface FlatRow {
  kind: 'header' | 'option';
  label: string;
  value?: any;
  disabled?: boolean;
  badge?: string;
  /** index into the navigable option list (only for kind === 'option') */
  optionIndex?: number;
}

function isGroup(item: DesktopSelectOption | DesktopSelectOptionGroup): item is DesktopSelectOptionGroup {
  return Array.isArray((item as DesktopSelectOptionGroup).options);
}

/**
 * Creamsicle-styled dropdown that replaces native <select> everywhere in the app.
 *
 * The panel is rendered through a CDK overlay (body-level), so it positions
 * correctly even inside modals/wizards that use CSS transforms, auto-flips when
 * there's no room below, and follows the trigger on scroll.
 *
 * Implements ControlValueAccessor, so it works with `[(ngModel)]`,
 * `[ngModel]` + `(ngModelChange)`, and reactive forms.
 *
 *   <desktop-select [(ngModel)]="value" [options]="opts" placeholder="Choose…" />
 */
@Component({
  selector: 'desktop-select',
  standalone: true,
  imports: [CommonModule, OverlayModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => DesktopSelectComponent),
      multi: true,
    },
  ],
  template: `
    <button
      #triggerEl
      cdkOverlayOrigin
      #origin="cdkOverlayOrigin"
      type="button"
      class="ds-trigger"
      [class.ds-sm]="size === 'sm'"
      [class.ds-md]="size === 'md'"
      [class.ds-lg]="size === 'lg'"
      [class.open]="isOpen()"
      [class.placeholder]="!hasSelection()"
      [disabled]="disabled"
      [attr.id]="id"
      [attr.aria-label]="ariaLabel"
      aria-haspopup="listbox"
      [attr.aria-expanded]="isOpen()"
      (click)="toggle()"
      (keydown)="onTriggerKeydown($event)"
    >
      <span class="ds-value">{{ selectedLabel() || placeholder }}</span>
      @if (selectedBadge()) {
        <span class="ds-value-badge">{{ selectedBadge() }}</span>
      }
      <span class="ds-chevron" aria-hidden="true">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2.5"
             stroke-linecap="round" stroke-linejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </span>
    </button>

    <ng-template
      cdkConnectedOverlay
      [cdkConnectedOverlayOrigin]="origin"
      [cdkConnectedOverlayOpen]="isOpen()"
      [cdkConnectedOverlayWidth]="triggerWidth()"
      [cdkConnectedOverlayPositions]="positions"
      [cdkConnectedOverlayHasBackdrop]="true"
      cdkConnectedOverlayBackdropClass="cdk-overlay-transparent-backdrop"
      (backdropClick)="close()"
      (detach)="close()"
    >
      <div #panel class="ds-panel" role="listbox" (keydown)="onTriggerKeydown($event)">
        @for (row of rows(); track $index) {
          @if (row.kind === 'header') {
            <div class="ds-group-header">{{ row.label }}</div>
          } @else {
            <button
              type="button"
              class="ds-option"
              role="option"
              [class.selected]="isSelected(row.value)"
              [class.active]="row.optionIndex === activeIndex()"
              [attr.aria-selected]="isSelected(row.value)"
              [disabled]="row.disabled"
              (mouseenter)="activeIndex.set(row.optionIndex!)"
              (click)="choose(row.value)"
            >
              <span class="ds-option-label">{{ row.label }}</span>
              @if (row.badge) {
                <span class="ds-option-badge">{{ row.badge }}</span>
              }
              @if (isSelected(row.value)) {
                <span class="ds-check" aria-hidden="true">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                       stroke="currentColor" stroke-width="3"
                       stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </span>
              }
            </button>
          }
        }
        @if (rows().length === 0) {
          <div class="ds-empty">No options</div>
        }
      </div>
    </ng-template>
  `,
  styles: [`
    @use '../../styles/variables' as *;
    @use '../../styles/mixins' as *;

    :host {
      display: block;
      position: relative;
    }

    .ds-trigger {
      @include button-reset;
      @include flex-between;
      gap: $spacing-2;
      width: 100%;
      font-family: $font-body;
      color: var(--text-primary);
      background: var(--bg-input, var(--bg-surface));
      border: 1px solid var(--border-input, var(--border-default));
      border-radius: $radius-md;
      transition: border-color $duration-fast $ease-out,
                  box-shadow $duration-fast $ease-out,
                  background-color $duration-fast $ease-out;
      text-align: left;

      &:hover:not(:disabled) {
        border-color: var(--border-strong);
      }

      &.open,
      &:focus-visible {
        outline: none;
        border-color: var(--accent);
        box-shadow: var(--focus-ring);
      }

      &.open {
        background: var(--bg-elevated, var(--bg-surface));
      }

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      &.placeholder .ds-value {
        color: var(--text-muted);
      }

      &.ds-sm {
        height: 26px;
        padding: 0 $spacing-2-5;
        font-size: $font-size-sm;
        border-radius: $radius-sm;
      }
      &.ds-md {
        height: 32px;
        padding: 0 $spacing-3;
        font-size: $font-size-base;
      }
      &.ds-lg {
        height: 40px;
        padding: 0 $spacing-4;
        font-size: $font-size-md;
      }
    }

    .ds-value {
      @include truncate;
      flex: 1;
      min-width: 0;
    }

    // Trailing badge (e.g. a change count) pinned right of the value; never
    // shrinks or truncates, so the value ellipsizes before the badge is lost.
    .ds-value-badge {
      flex-shrink: 0;
      margin-left: $spacing-2;
      color: var(--text-tertiary);
      font-size: 0.85em;
      font-variant-numeric: tabular-nums;
    }

    .ds-chevron {
      display: flex;
      align-items: center;
      flex-shrink: 0;
      color: var(--text-tertiary);
      transition: transform $duration-moderate $ease-bounce, color $duration-fast $ease-out;
    }

    .ds-trigger.open .ds-chevron {
      transform: rotate(180deg);
      color: var(--accent);
    }
  `,
  // The panel renders inside the CDK overlay (body-level), so its styles must
  // not rely on :host. Kept in a separate block for clarity.
  `
    @use '../../styles/variables' as *;
    @use '../../styles/mixins' as *;

    .ds-panel {
      padding: $spacing-1;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: $radius-lg;
      box-shadow:
        0 0 0 1px rgba(0, 0, 0, 0.04),
        0 6px 16px -4px rgba(0, 0, 0, 0.18),
        0 14px 40px -8px rgba(0, 0, 0, 0.28);
      max-height: min(340px, 60vh);
      overflow-y: auto;
      overscroll-behavior: contain;
      transform-origin: var(--ds-origin, top center);
      animation: dsPanelIn $duration-normal $ease-bounce;
      @include scrollbar-thin;

      // A whisper of the accent at the very top edge for personality.
      border-top: 2px solid var(--accent);
      border-top-left-radius: $radius-lg;
      border-top-right-radius: $radius-lg;
    }

    @keyframes dsPanelIn {
      from { opacity: 0; transform: translateY(-6px) scale(0.96); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }

    .ds-group-header {
      @include text-caps;
      position: sticky;
      top: 0;
      z-index: 1;
      padding: $spacing-2 $spacing-3 $spacing-1;
      color: var(--text-tertiary);
      background: var(--bg-elevated);
    }

    .ds-option {
      @include button-reset;
      display: flex;
      align-items: center;
      gap: $spacing-2;
      width: 100%;
      padding: $spacing-2 $spacing-2-5;
      border-radius: $radius-md;
      color: var(--text-primary);
      font-family: $font-body;
      font-size: $font-size-base;
      text-align: left;
      position: relative;
      transition: background-color $duration-fast $ease-out,
                  color $duration-fast $ease-out,
                  padding-left $duration-fast $ease-out;

      // Sliding accent bar revealed on the active row.
      &::before {
        content: '';
        position: absolute;
        left: 4px;
        top: 50%;
        width: 3px;
        height: 0;
        border-radius: $radius-full;
        background: var(--accent);
        transform: translateY(-50%);
        transition: height $duration-fast $ease-out;
      }

      &.active:not(:disabled) {
        background: var(--hover-bg);
        padding-left: $spacing-3-5;

        &::before { height: 16px; }
      }

      &.selected {
        color: var(--accent);
        font-weight: $font-weight-medium;
        background: var(--accent-subtle, color-mix(in srgb, var(--accent) 12%, transparent));
      }

      &.selected.active:not(:disabled) {
        background: var(--accent-muted, color-mix(in srgb, var(--accent) 18%, transparent));
      }

      &:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
    }

    .ds-option-label {
      @include truncate;
      flex: 1;
      min-width: 0;
    }

    // Mirror of .ds-value-badge for the dropdown rows: pinned right, never
    // truncated, so the count survives even when the label is clipped.
    .ds-option-badge {
      flex-shrink: 0;
      margin-left: $spacing-2;
      color: var(--text-tertiary);
      font-size: 0.85em;
      font-variant-numeric: tabular-nums;
    }

    .ds-check {
      display: flex;
      align-items: center;
      flex-shrink: 0;
      color: var(--accent);
      animation: dsCheckIn $duration-normal $ease-bounce;
    }

    @keyframes dsCheckIn {
      from { opacity: 0; transform: scale(0.4); }
      to   { opacity: 1; transform: scale(1); }
    }

    .ds-empty {
      padding: $spacing-2 $spacing-3;
      font-size: $font-size-sm;
      color: var(--text-muted);
    }
  `],
})
export class DesktopSelectComponent implements ControlValueAccessor {
  private readonly _options = signal<DesktopSelectItems>([]);
  /**
   * Options input — stored in a signal so the `rows` computed reacts when the
   * bound value changes (e.g. async-loaded models/voices arriving after first
   * render). A plain @Input would leave `rows` frozen on its first value.
   */
  @Input()
  set options(value: DesktopSelectItems) {
    this._options.set(value ?? []);
  }
  get options(): DesktopSelectItems {
    return this._options();
  }

  @Input() placeholder = 'Select…';
  @Input() size: DesktopSelectSize = 'md';
  @Input() id?: string;
  @Input() ariaLabel?: string;

  @Input()
  set disabled(value: boolean) {
    this._disabled.set(value);
  }
  get disabled(): boolean {
    return this._disabled();
  }

  /** Fires in addition to the ControlValueAccessor change, for non-form callers. */
  @Output() valueChange = new EventEmitter<any>();

  @ViewChild('triggerEl') triggerRef?: ElementRef<HTMLButtonElement>;
  @ViewChild('panel') panelRef?: ElementRef<HTMLDivElement>;
  @ViewChild('origin') origin?: CdkOverlayOrigin;

  /** Overlay positions: prefer below the trigger, flip above when cramped. */
  readonly positions: ConnectedPosition[] = [
    { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top', offsetY: 6 },
    { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom', offsetY: -6 },
  ];

  readonly value = signal<any>(null);
  private readonly _disabled = signal(false);
  readonly isOpen = signal(false);
  readonly activeIndex = signal(0);
  readonly triggerWidth = signal<number>(0);

  private onChange: (value: any) => void = () => {};
  private onTouched: () => void = () => {};

  /** Flattened render rows (group headers + options). */
  readonly rows = computed<FlatRow[]>(() => {
    const out: FlatRow[] = [];
    let optionIndex = 0;
    for (const item of this._options()) {
      if (isGroup(item)) {
        out.push({ kind: 'header', label: item.label });
        for (const opt of item.options) {
          out.push({ kind: 'option', label: opt.label, value: opt.value, disabled: opt.disabled, badge: opt.badge, optionIndex: optionIndex++ });
        }
      } else {
        out.push({ kind: 'option', label: item.label, value: item.value, disabled: item.disabled, badge: item.badge, optionIndex: optionIndex++ });
      }
    }
    return out;
  });

  /** Navigable (non-header) options in display order. */
  private readonly flatOptions = computed<FlatRow[]>(() =>
    this.rows().filter((r) => r.kind === 'option'),
  );

  readonly selectedLabel = computed<string | null>(() => {
    const v = this.value();
    const match = this.flatOptions().find((o) => o.value === v);
    return match ? match.label : null;
  });

  readonly selectedBadge = computed<string | null>(() => {
    const v = this.value();
    const match = this.flatOptions().find((o) => o.value === v);
    return match?.badge ?? null;
  });

  readonly hasSelection = computed(() => this.selectedLabel() !== null);

  isSelected(v: any): boolean {
    return this.value() === v;
  }

  // ── ControlValueAccessor ────────────────────────────────────────────────
  writeValue(value: any): void {
    this.value.set(value);
  }
  registerOnChange(fn: (value: any) => void): void {
    this.onChange = fn;
  }
  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }
  setDisabledState(isDisabled: boolean): void {
    this._disabled.set(isDisabled);
  }

  // ── Interaction ─────────────────────────────────────────────────────────
  toggle(): void {
    if (this.disabled) return;
    this.isOpen() ? this.close() : this.open();
  }

  open(): void {
    if (this.disabled || this.isOpen()) return;
    const el = this.triggerRef?.nativeElement;
    if (el) this.triggerWidth.set(el.offsetWidth);
    // Position the active marker on the current selection.
    const opts = this.flatOptions();
    const currentIdx = opts.findIndex((o) => o.value === this.value());
    this.activeIndex.set(currentIdx >= 0 ? currentIdx : 0);
    this.isOpen.set(true);
    this.scrollActiveIntoView();
  }

  close(): void {
    if (!this.isOpen()) return;
    this.isOpen.set(false);
    this.onTouched();
  }

  choose(v: any): void {
    if (this.value() !== v) {
      this.value.set(v);
      this.onChange(v);
      this.valueChange.emit(v);
    }
    this.close();
    this.triggerRef?.nativeElement.focus();
  }

  // ── Keyboard ────────────────────────────────────────────────────────────
  onTriggerKeydown(event: KeyboardEvent): void {
    if (this.disabled) return;

    if (!this.isOpen()) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault();
        this.open();
      }
      return;
    }

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.moveActive(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.moveActive(-1);
        break;
      case 'Home':
        event.preventDefault();
        this.setActiveToEdge(1);
        break;
      case 'End':
        event.preventDefault();
        this.setActiveToEdge(-1);
        break;
      case 'Enter':
      case ' ': {
        event.preventDefault();
        const opt = this.flatOptions()[this.activeIndex()];
        if (opt && !opt.disabled) this.choose(opt.value);
        break;
      }
      case 'Escape':
        event.preventDefault();
        this.close();
        this.triggerRef?.nativeElement.focus();
        break;
      case 'Tab':
        this.close();
        break;
    }
  }

  private moveActive(delta: number): void {
    const opts = this.flatOptions();
    if (opts.length === 0) return;
    let idx = this.activeIndex();
    for (let i = 0; i < opts.length; i++) {
      idx = (idx + delta + opts.length) % opts.length;
      if (!opts[idx].disabled) break;
    }
    this.activeIndex.set(idx);
    this.scrollActiveIntoView();
  }

  private setActiveToEdge(direction: 1 | -1): void {
    const opts = this.flatOptions();
    if (opts.length === 0) return;
    if (direction === 1) {
      const idx = opts.findIndex((o) => !o.disabled);
      if (idx >= 0) this.activeIndex.set(idx);
    } else {
      for (let i = opts.length - 1; i >= 0; i--) {
        if (!opts[i].disabled) {
          this.activeIndex.set(i);
          break;
        }
      }
    }
    this.scrollActiveIntoView();
  }

  private scrollActiveIntoView(): void {
    // The panel lives in the overlay container; query the DOM for the open one.
    setTimeout(() => {
      const active = document.querySelector('.ds-panel .ds-option.active') as HTMLElement | null;
      active?.scrollIntoView({ block: 'nearest' });
    });
  }
}
