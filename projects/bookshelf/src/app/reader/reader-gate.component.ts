import { Component, inject, OnInit, signal } from '@angular/core';
import { ReaderService } from '../services/reader.service';
import { ServerConfigService } from '../services/server-config.service';
import { ReaderSummary } from '../models/types';

/**
 * Full-screen "Who's reading?" gate. Shown when no reader is active. Pick a
 * profile (entering a PIN if one is set) or add a new reader.
 */
@Component({
  selector: 'app-reader-gate',
  standalone: true,
  template: `
    <div class="gate">
      <div class="panel">
        @if (mode() === 'list') {
          <h1>Who's reading?</h1>
          <div class="readers">
            @for (r of readers(); track r.id) {
              <button class="reader" (click)="pick(r)">
                <span class="avatar">{{ initial(r.name) }}</span>
                <span class="name">{{ r.name }}</span>
                @if (r.hasPin) { <span class="lock">🔒</span> }
              </button>
            }
            <button class="reader add" (click)="startAdd()">
              <span class="avatar plus">+</span>
              <span class="name">Add reader</span>
            </button>
          </div>
          @if (readers().length === 0 && loaded()) {
            <p class="hint">No readers yet — add one to start tracking your listening.</p>
          }
          <!-- Profiles are analytics-only and the same books are available to
               everyone, so choosing one is optional — you can just browse. -->
          <button class="skip" (click)="skip()">Browse as guest</button>
          @if (cfg.isNative) {
            <button class="link" (click)="cfg.openPrompt()">Not your library? Switch server</button>
          }
        } @else if (mode() === 'pin') {
          <button class="back" (click)="toList()">‹ Back</button>
          <h1>{{ selected()?.name }}</h1>
          <p class="hint">Enter your PIN</p>
          <input class="pin" type="password" inputmode="numeric" maxlength="8" autofocus
            [value]="pin()" (input)="pin.set($any($event.target).value)"
            (keyup.enter)="confirmPin()" />
          @if (error()) { <p class="error">{{ error() }}</p> }
          <button class="primary" (click)="confirmPin()" [disabled]="busy()">Continue</button>
        } @else {
          <button class="back" (click)="toList()">‹ Back</button>
          <h1>Add reader</h1>
          <input class="text" type="text" placeholder="Name" autofocus
            [value]="newName()" (input)="newName.set($any($event.target).value)" />
          <input class="text" type="password" inputmode="numeric" maxlength="8" placeholder="PIN (optional)"
            [value]="newPin()" (input)="newPin.set($any($event.target).value)" />
          @if (error()) { <p class="error">{{ error() }}</p> }
          <button class="primary" (click)="create()" [disabled]="busy() || !newName().trim()">Create</button>
        }
      </div>
    </div>
  `,
  styles: [`
    .gate { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center;
      background: var(--bg-base); padding: 24px; }
    .panel { width: 100%; max-width: 440px; display: flex; flex-direction: column; align-items: center; gap: 20px; }
    h1 { font-size: 24px; font-weight: 700; color: var(--text-primary); text-align: center; }
    .hint { font-size: 14px; color: var(--text-secondary); text-align: center; margin-top: -8px; }
    .error { font-size: 13px; color: var(--error); text-align: center; }

    .readers { display: flex; flex-wrap: wrap; gap: 18px; justify-content: center; }
    .reader { display: flex; flex-direction: column; align-items: center; gap: 8px; border: none; background: transparent; cursor: pointer; position: relative; }
    .avatar { width: 84px; height: 84px; border-radius: 16px; display: flex; align-items: center; justify-content: center;
      font-size: 34px; font-weight: 700; color: #fff; background: linear-gradient(135deg, var(--accent), var(--accent-hover));
      transition: transform 0.15s, box-shadow 0.15s; }
    .reader:hover .avatar { transform: translateY(-3px); box-shadow: 0 10px 28px color-mix(in srgb, var(--accent) 40%, transparent); }
    .avatar.plus { background: var(--bg-elevated); color: var(--text-secondary); border: 2px dashed var(--border-subtle); }
    .name { font-size: 14px; color: var(--text-secondary); }
    .lock { position: absolute; top: -4px; right: 8px; font-size: 13px; }

    .text, .pin { width: 100%; padding: 14px 16px; font-size: 16px; background: var(--bg-elevated);
      border: 1px solid var(--border-subtle); border-radius: 10px; color: var(--text-primary); outline: none; text-align: center; }
    .pin { letter-spacing: 8px; font-size: 22px; }
    .text:focus, .pin:focus { border-color: var(--accent); }

    .primary { width: 100%; padding: 14px; border: none; border-radius: 10px; background: var(--accent); color: #fff;
      font-size: 15px; font-weight: 600; cursor: pointer; }
    .primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .back { align-self: flex-start; border: none; background: transparent; color: var(--text-secondary); font-size: 14px; cursor: pointer; padding: 0; }
    .skip { margin-top: 4px; padding: 12px 20px; border: 1px solid var(--border-subtle); border-radius: 10px;
      background: var(--bg-elevated); color: var(--text-primary); font-size: 14px; font-weight: 600; cursor: pointer; }
    .link { border: none; background: transparent; color: var(--text-secondary); font-size: 13px; cursor: pointer; padding: 2px; }
  `],
})
export class ReaderGateComponent implements OnInit {
  private readonly readerSvc = inject(ReaderService);
  readonly cfg = inject(ServerConfigService);

  readonly mode = signal<'list' | 'pin' | 'add'>('list');
  readonly readers = signal<ReaderSummary[]>([]);
  readonly loaded = signal(false);
  readonly selected = signal<ReaderSummary | null>(null);
  readonly pin = signal('');
  readonly newName = signal('');
  readonly newPin = signal('');
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);

  async ngOnInit(): Promise<void> {
    try {
      this.readers.set(await this.readerSvc.listReaders());
    } catch { /* server unreachable */ }
    this.loaded.set(true);
  }

  initial(name: string): string {
    return (name.trim()[0] || '?').toUpperCase();
  }

  /** Dismiss the picker and browse without a profile (analytics-only, skippable). */
  skip(): void {
    this.readerSvc.browseAsGuest();
  }

  pick(r: ReaderSummary): void {
    this.error.set(null);
    if (r.hasPin) {
      this.selected.set(r);
      this.pin.set('');
      this.mode.set('pin');
    } else {
      this.signIn(r.id);
    }
  }

  async confirmPin(): Promise<void> {
    const r = this.selected();
    if (r) await this.signIn(r.id, this.pin());
  }

  private async signIn(id: string, pin?: string): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.readerSvc.selectReader(id, pin);
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  startAdd(): void {
    this.error.set(null);
    this.newName.set('');
    this.newPin.set('');
    this.mode.set('add');
  }

  async create(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.readerSvc.addReader(this.newName().trim(), this.newPin() || undefined);
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  toList(): void {
    this.error.set(null);
    this.mode.set('list');
  }
}
