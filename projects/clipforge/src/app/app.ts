import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ClipforgeApiService } from './services/clipforge-api.service';
import { ClipforgeCollectionSummary } from './models/types';
import { CollectionsRailComponent } from './collections/collections-rail.component';
import { CollectionViewComponent } from './collection/collection-view.component';

/**
 * ClipForge shell: collections rail on the left, the open collection on the
 * right. Owns the top-level state (root, collection list, selection) and the
 * only writes to it. Errors are shown, never swallowed.
 */
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, CollectionsRailComponent, CollectionViewComponent],
  template: `
    <div class="shell">
      <cf-collections-rail
        [collections]="collections()"
        [selected]="selectedName()"
        [root]="root()"
        [rootSet]="rootSet()"
        (openCollection)="open($event)"
        (create)="createCollection()"
        (chooseRoot)="chooseRoot()"
      />
      <main class="main">
        @if (topError(); as e) {
          <div class="top-error">{{ e }}</div>
        }
        @if (selectedName(); as name) {
          <cf-collection-view [name]="name" />
        } @else {
          <div class="placeholder">
            @if (!rootSet()) {
              <h1>Welcome to ClipForge</h1>
              <p>Choose a folder to hold your collections to get started.</p>
              <button type="button" class="cta" (click)="chooseRoot()">Choose collections folder…</button>
            } @else {
              <h1>No collection open</h1>
              <p>Pick a collection on the left, or create a new one.</p>
              <button type="button" class="cta" (click)="createCollection()">New collection</button>
            }
          </div>
        }
      </main>
    </div>

    @if (creating()) {
      <div class="modal-backdrop" (click)="cancelCreate()">
        <div class="modal" (click)="$event.stopPropagation()">
          <h2>New collection</h2>
          <input
            #nameInput
            class="modal-input"
            type="text"
            placeholder="Collection name"
            [ngModel]="newName()"
            (ngModelChange)="newName.set($event)"
            (keydown.enter)="confirmCreate()"
            (keydown.escape)="cancelCreate()"
            autofocus
          />
          @if (createError(); as e) {
            <div class="modal-error">{{ e }}</div>
          }
          <div class="modal-actions">
            <button type="button" class="ghost" (click)="cancelCreate()">Cancel</button>
            <button type="button" class="cta" (click)="confirmCreate()" [disabled]="!newName().trim()">Create</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    :host { display: block; height: 100vh; }
    .shell { display: flex; height: 100vh; background: var(--bg-base); color: var(--text-primary); }
    .main { flex: 1; min-width: 0; height: 100%; display: flex; flex-direction: column; background: var(--bg-content); }
    .top-error {
      margin: var(--ui-spacing-lg, 16px); padding: 10px 14px; border-radius: 8px;
      background: var(--error-bg); color: var(--error-text); border: 1px solid var(--error);
      font-size: var(--ui-font-sm, 13px);
    }
    .placeholder { margin: auto; text-align: center; max-width: 460px; padding: 32px; }
    .placeholder h1 { font-size: var(--ui-font-xl, 20px); margin-bottom: 8px; }
    .placeholder p { color: var(--text-secondary); margin-bottom: 20px; }
    .cta {
      height: var(--ui-btn-height-sm, 44px); padding: 0 20px; border-radius: 8px;
      border: 1px solid var(--border-strong); background: var(--accent); color: var(--text-inverse);
      font-weight: 600; cursor: pointer;
    }
    .cta:disabled { opacity: 0.5; cursor: default; }
    .modal-backdrop {
      position: fixed; inset: 0; background: var(--bg-overlay);
      display: flex; align-items: center; justify-content: center; z-index: 50;
    }
    .modal {
      width: 420px; max-width: 90vw; padding: 24px; border-radius: 12px;
      background: var(--bg-elevated); border: 1px solid var(--border-default); box-shadow: var(--shadow-lg);
    }
    .modal h2 { font-size: var(--ui-font-lg, 18px); margin-bottom: 16px; }
    .modal-input {
      width: 100%; height: var(--ui-btn-height-sm, 44px); padding: 0 12px; border-radius: 8px;
      background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-input);
      font-size: var(--ui-font-base, 15px);
    }
    .modal-error { margin-top: 10px; color: var(--error-text); font-size: var(--ui-font-sm, 13px); }
    .modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; }
    .ghost {
      height: var(--ui-btn-height-sm, 44px); padding: 0 16px; border-radius: 8px;
      border: 1px solid var(--border-strong); background: var(--bg-surface); color: var(--text-primary); cursor: pointer;
    }
  `],
})
export class App implements OnInit {
  private readonly api = inject(ClipforgeApiService);

  readonly root = signal<string | null>(null);
  readonly collections = signal<ClipforgeCollectionSummary[]>([]);
  readonly selectedName = signal<string | null>(null);
  readonly topError = signal<string | null>(null);

  // New-collection modal state.
  readonly creating = signal(false);
  readonly newName = signal('');
  readonly createError = signal<string | null>(null);

  rootSet(): boolean {
    return !!this.root();
  }

  async ngOnInit(): Promise<void> {
    await this.refreshRoot();
  }

  private async refreshRoot(): Promise<void> {
    this.topError.set(null);
    try {
      const root = await this.api.getRoot();
      this.root.set(root);
      if (root) {
        await this.refreshCollections();
      }
    } catch (err) {
      this.topError.set(this.msg(err));
    }
  }

  private async refreshCollections(): Promise<void> {
    try {
      const list = await this.api.listCollections();
      this.collections.set(list);
      // Drop the selection if it no longer exists.
      const sel = this.selectedName();
      if (sel && !list.some((c) => c.name === sel)) {
        this.selectedName.set(null);
      }
    } catch (err) {
      this.topError.set(this.msg(err));
    }
  }

  async chooseRoot(): Promise<void> {
    this.topError.set(null);
    try {
      const chosen = await this.api.chooseRoot();
      this.root.set(chosen);
      if (chosen) {
        this.selectedName.set(null);
        await this.refreshCollections();
      }
    } catch (err) {
      this.topError.set(this.msg(err));
    }
  }

  createCollection(): void {
    this.newName.set('');
    this.createError.set(null);
    this.creating.set(true);
  }

  cancelCreate(): void {
    this.creating.set(false);
    this.createError.set(null);
  }

  async confirmCreate(): Promise<void> {
    const name = this.newName().trim();
    if (!name) return;
    this.createError.set(null);
    try {
      const manifest = await this.api.createCollection(name);
      this.creating.set(false);
      await this.refreshCollections();
      this.selectedName.set(manifest.name);
    } catch (err) {
      // Keep the modal open and show the validation/collision error inline.
      this.createError.set(this.msg(err));
    }
  }

  open(name: string): void {
    this.selectedName.set(name);
  }

  private msg(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
  }
}
