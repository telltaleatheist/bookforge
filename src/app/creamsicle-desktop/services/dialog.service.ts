import {
  Injectable,
  ApplicationRef,
  EnvironmentInjector,
  createComponent,
  ComponentRef,
  inject,
} from '@angular/core';
import {
  DesktopDialogComponent,
  DesktopDialogType,
} from '../components/desktop-dialog/desktop-dialog.component';

export interface AlertOptions {
  message: string;
  title?: string;
  detail?: string;
  type?: DesktopDialogType;
  confirmLabel?: string;
}

export interface ConfirmOptions {
  message: string;
  title?: string;
  detail?: string;
  type?: DesktopDialogType;
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface PromptOptions {
  message: string;
  title?: string;
  detail?: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

/**
 * In-app replacement for the browser `alert()` / `confirm()` dialogs.
 * Renders a {@link DesktopDialogComponent} on top of everything and resolves a
 * promise when the user responds. Use this instead of `window.alert` / `confirm`.
 */
@Injectable({ providedIn: 'root' })
export class DialogService {
  private readonly appRef = inject(ApplicationRef);
  private readonly injector = inject(EnvironmentInjector);

  /** Show a single-button message. Resolves when dismissed. */
  alert(options: AlertOptions): Promise<void> {
    return new Promise<void>((resolve) => {
      const ref = this.mount({
        title: options.title ?? '',
        message: options.message,
        detail: options.detail,
        type: options.type ?? 'info',
        confirmLabel: options.confirmLabel ?? 'OK',
        showCancel: false,
      });
      const done = () => {
        this.destroy(ref);
        resolve();
      };
      ref.instance.confirm.subscribe(done);
      ref.instance.cancel.subscribe(done);
    });
  }

  /** Show a confirm/cancel dialog. Resolves true if confirmed, false otherwise. */
  confirm(options: ConfirmOptions): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const ref = this.mount({
        title: options.title ?? '',
        message: options.message,
        detail: options.detail,
        type: options.type ?? 'question',
        confirmLabel: options.confirmLabel ?? 'OK',
        cancelLabel: options.cancelLabel ?? 'Cancel',
        showCancel: true,
      });
      ref.instance.confirm.subscribe(() => {
        this.destroy(ref);
        resolve(true);
      });
      ref.instance.cancel.subscribe(() => {
        this.destroy(ref);
        resolve(false);
      });
    });
  }

  /** Show a text-input dialog. Resolves the trimmed entry, or null if cancelled
   *  or left empty. */
  prompt(options: PromptOptions): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      const ref = this.mount({
        title: options.title ?? '',
        message: options.message,
        detail: options.detail,
        type: 'question',
        confirmLabel: options.confirmLabel ?? 'OK',
        cancelLabel: options.cancelLabel ?? 'Cancel',
        showCancel: true,
        showInput: true,
        inputValue: options.initialValue ?? '',
        inputPlaceholder: options.placeholder ?? '',
      });
      ref.instance.confirm.subscribe(() => {
        const value = (ref.instance.inputValue ?? '').trim();
        this.destroy(ref);
        resolve(value.length ? value : null);
      });
      ref.instance.cancel.subscribe(() => {
        this.destroy(ref);
        resolve(null);
      });
    });
  }

  private mount(props: Partial<DesktopDialogComponent>): ComponentRef<DesktopDialogComponent> {
    const ref = createComponent(DesktopDialogComponent, {
      environmentInjector: this.injector,
    });
    Object.assign(ref.instance, props);
    this.appRef.attachView(ref.hostView);
    document.body.appendChild(ref.location.nativeElement);
    ref.changeDetectorRef.detectChanges();
    return ref;
  }

  private destroy(ref: ComponentRef<DesktopDialogComponent>): void {
    this.appRef.detachView(ref.hostView);
    ref.destroy();
  }
}
