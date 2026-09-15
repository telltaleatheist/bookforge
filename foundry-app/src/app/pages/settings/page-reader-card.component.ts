import { ChangeDetectionStrategy, Component, computed, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import type { PageReaderProgress, PageReaderState, ServerStatus } from '@shared/types';

import { api } from '../../core/foundry';

/**
 * Page reader (local) — the one backend this app installs and runs itself.
 *
 * ── Why this card exists, and what it replaced ───────────────────────────────
 *
 * Reading a page is the only act in foundry with no Ollama path: Ollama does not
 * serve dots.ocr. Until 2026-09-13 the answer on Windows was a card called "vLLM
 * in WSL" that asked for a distro, offered a conda-or-venv radio, streamed a pip
 * install, and then started a server — four questions and twenty minutes before
 * anybody could convert a PDF. Owen retired all of it: *"foundry should work if
 * they have no idea what theyre doing and they just want to convert PDFs to
 * EPUB"*. What is left is a llama.cpp build and two model files, one button, and
 * a sentence saying how big the download is before it starts.
 *
 * ── Honest about three things ────────────────────────────────────────────────
 *
 *  1. THE SIZE, BEFORE ASKING. `state.downloadBytes` is what pressing the button
 *     would actually fetch — only the missing pieces — and the button prints it.
 *     A null means the release indexes could not be read, and the row says that
 *     rather than drawing a zero.
 *  2. WHAT IS ON DISK. The release tag, the accelerator and both model files by
 *     name, because "installed" with nothing behind it is what a person has to
 *     take on trust.
 *  3. A SERVER THAT IS NOT OURS. When something was already answering on the
 *     port, Stop is disabled and the row says why. Killing a server this app did
 *     not start is how somebody loses work they were in the middle of.
 *
 * The Crucible connect offer belongs BESIDE this card, not inside it — it is a
 * second slot rather than a second way to fill this one (docs/SLOTS.md §3, and
 * package E). The placeholder comment in the template marks where.
 */
@Component({
  selector: 'app-page-reader-card',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card">
      <header class="head">
        <h2>Page reader (local)</h2>
        @if (state(); as it) {
          <span class="pill" [attr.data-ok]="it.installed">
            {{ it.installed ? 'Installed' : 'Not installed' }}
          </span>
        }
      </header>

      @if (state(); as it) {
        <p class="detail">{{ it.platformNote }}</p>

        @if (!it.supported) {
          <p class="warn">{{ it.detail }}</p>
        } @else {
          <p class="detail">{{ it.detail }}</p>

          <!--
            docs/SLOTS.md §5b. A Crucible ON THIS MACHINE serving pages owns the
            weights for it here, so Foundry's own copy is a duplicate and has
            been removed. The Install button below is OFF rather than gone: a
            button that vanishes teaches somebody the app is broken, and one that
            is off with a sentence beside it teaches them what took the job over.
            A REMOTE Crucible deliberately does not land here — the local reader
            is what works when the Mac is asleep.
          -->
          @if (it.supersededBy; as server) {
            <p class="detail">
              The Crucible on this machine ({{ server }}) is reading pages, so Foundry does not
              need its own copy of the reader here. Removing that server, or switching it off,
              brings this back.
            </p>
          }

          <!-- ── What is on disk, named ───────────────────────────────── -->
          <ul class="files">
            <li>
              <span class="dot" [attr.data-ok]="it.binary.path !== null"></span>
              <span class="name">llama-server</span>
              <span class="small mono">
                @if (it.binary.release) { {{ it.binary.release }} · {{ it.binary.accel }} }
                @else { not here yet }
              </span>
            </li>
            @for (file of it.models; track file.name) {
              <li>
                <span class="dot" [attr.data-ok]="file.present"></span>
                <span class="name mono">{{ file.name }}</span>
                <span class="small mono">
                  @if (file.bytes) { {{ size(file.bytes) }} } @else { size unknown }
                </span>
              </li>
            }
          </ul>

          <!-- ── The download ─────────────────────────────────────────── -->
          <div class="actions">
            @if (!it.installed) {
              <button class="primary" type="button"
                      [disabled]="busy() || it.supersededBy !== null"
                      (click)="install()">
                @if (it.downloadBytes !== null) {
                  Download it ({{ size(it.downloadBytes) }})
                } @else {
                  Download it
                }
              </button>
            }
            @if (busy()) {
              <button class="ghost" type="button" (click)="cancelInstall()">Cancel</button>
            }
            @if (it.installed) {
              <button class="ghost" type="button"
                      [disabled]="busy() || it.server.state === 'starting'"
                      (click)="start()">Start</button>
              <button class="ghost" type="button"
                      [disabled]="busy() || it.server.external || it.server.state === 'stopped'"
                      (click)="stop()">Stop</button>
            }
            <button class="ghost" type="button" [disabled]="busy()" (click)="refresh()">Check again</button>
          </div>

          @if (said(); as progress) {
            @if (progress.phase === 'download') {
              <div class="bar"><div class="fill" [style.width.%]="progress.percent"></div></div>
            }
            <p class="small" [class.bad]="progress.phase === 'error'">
              {{ progress.item }} — {{ progress.detail }}
            </p>
          }

          <!-- ── The server ───────────────────────────────────────────── -->
          @if (it.installed) {
            <div class="server">
              <span class="dot" [attr.data-state]="status().state"></span>
              <span class="name">{{ stateWord() }}</span>
              @if (status().external) { <span class="badge">not ours</span> }
              <span class="small mono">{{ status().url }} · {{ status().model }}</span>
            </div>
            <pre class="log">{{ status().detail }}</pre>

            <label class="field">
              <span class="label">Keep warm for</span>
              <input type="number" min="0" max="240" [ngModel]="keepWarm()"
                     (ngModelChange)="keepWarm.set($event)" (blur)="saveKeepWarm()"
                     name="page-reader-keep-warm">
              <span class="small">minutes after the queue empties. 0 = stop immediately.</span>
            </label>
          }
        }

        <!--
          PACKAGE E GOES HERE: the offer to connect a Crucible server instead of,
          or beside, this one. It is a SLOT of its own rather than a setting on
          this card (docs/SLOTS.md §3) — since Wave 66 every GPU slot is a
          registered engine and one on this machine is no different from one in
          the next room — so it wants its own card in this column, not a field in
          this one.
        -->
      } @else {
        <p class="detail">Looking…</p>
      }
    </section>
  `,
  styles: [`
    .card { border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px;
            background: var(--bg-raised); display: flex; flex-direction: column; gap: 10px; }
    .head { display: flex; align-items: center; gap: 10px; }
    .head h2 { flex: 1; margin: 0; font-size: 14px; font-weight: 600; }

    .pill { font-size: 11px; padding: 2px 8px; border-radius: 10px;
            background: var(--bg-sunken); color: var(--text-tertiary); }
    .pill[data-ok="true"] { color: var(--ok); }

    .detail { margin: 0; font-size: 12px; color: var(--text-secondary); }
    .small { margin: 0; font-size: 11px; color: var(--text-tertiary); word-break: break-word; }
    .small.bad, .bad { color: var(--error); }
    .warn { margin: 0; font-size: 12px; color: var(--warn); }
    .mono { font-family: var(--mono); }

    .files { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
    .files li { display: flex; align-items: center; gap: 8px; font-size: 12px; }
    .files .name { flex: 0 0 auto; }
    .files .small { margin-left: auto; }

    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-tertiary); flex: none; }
    .dot[data-ok="true"] { background: var(--ok); }
    .dot[data-state="ready"] { background: var(--ok); }
    .dot[data-state="starting"] { background: var(--warn); }
    .dot[data-state="failed"] { background: var(--error); }

    .actions { display: flex; flex-wrap: wrap; gap: 8px; }

    .bar { height: 4px; background: var(--bg-sunken); border-radius: 2px; overflow: hidden; }
    .fill { height: 100%; background: var(--accent); transition: width 0.2s ease; }

    .server { display: flex; align-items: center; gap: 8px; font-size: 12px; }
    .server .small { margin-left: auto; }
    .badge { font-size: 10px; padding: 1px 6px; border-radius: 8px;
             background: var(--bg-sunken); color: var(--text-tertiary); }

    .log { margin: 0; padding: 8px; max-height: 140px; overflow: auto; white-space: pre-wrap;
           font-family: var(--mono); font-size: 11px; color: var(--text-tertiary);
           background: var(--bg-sunken); border-radius: 6px; }

    .field { display: flex; align-items: center; gap: 8px; font-size: 12px; }
    .field .label { flex: none; }
    .field input { width: 72px; }
  `],
})
export class PageReaderCardComponent {
  /** An install or a start finished: the tier cards upstairs may have changed. */
  readonly changed = output<void>();

  protected readonly state = signal<PageReaderState | null>(null);
  protected readonly said = signal<PageReaderProgress | null>(null);
  protected readonly busy = signal(false);
  protected readonly keepWarm = signal(0);

  /**
   * The status the PUSH last carried, falling back to the one the state read
   * came with.
   *
   * Two sources for one fact, and the push wins because it is the live one: a
   * server that started or failed while this page was open says so through
   * `page-reader:status-changed`, and re-reading the whole state to learn it
   * would be a directory walk per log line.
   */
  private readonly pushed = signal<ServerStatus | null>(null);
  protected readonly status = computed<ServerStatus>(() =>
    this.pushed() ?? this.state()?.server
    ?? { state: 'stopped', detail: 'Not started.', url: '', model: '', external: false });

  constructor() {
    if (!api) return;
    // Subscribed once and never torn down: this card lives as long as the
    // settings page, and a download runs for many minutes in main.
    api.pageReader.onProgress((progress) => {
      this.said.set(progress);
      if (progress.phase === 'done' || progress.phase === 'error') {
        this.busy.set(false);
        void this.refresh();
        this.changed.emit();
      }
    });
    api.pageReader.onStatus((status) => this.pushed.set(status));
    void this.refresh();
  }

  protected async refresh(): Promise<void> {
    if (!api) return;
    const next = await api.pageReader.state();
    this.state.set(next);
    this.keepWarm.set(next.keepWarmMinutes);
  }

  protected stateWord(): string {
    switch (this.status().state) {
      case 'ready': return 'Serving';
      case 'starting': return 'Starting…';
      case 'failed': return 'Failed';
      default: return 'Stopped';
    }
  }

  protected size(bytes: number): string {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
    if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
    return `${Math.round(bytes / 1024)} KB`;
  }

  protected async install(): Promise<void> {
    if (!api) return;
    this.busy.set(true);
    this.said.set(null);
    // The result carries the SAME sentence the terminal progress event does, and
    // it is set here too so a broadcast that arrives after a window reload — or
    // does not arrive at all — still leaves the outcome on screen.
    const result = await api.pageReader.install();
    this.busy.set(false);
    this.said.set({
      item: 'all',
      phase: result.ok ? 'done' : 'error',
      percent: result.ok ? 100 : 0,
      detail: result.detail,
    });
    await this.refresh();
    this.changed.emit();
  }

  protected cancelInstall(): void {
    void api?.pageReader.cancelInstall();
    this.busy.set(false);
  }

  protected async start(): Promise<void> {
    if (!api) return;
    this.busy.set(true);
    try {
      this.pushed.set(await api.pageReader.start());
    } catch (err) {
      // The server's own log tail comes back on the rejection, whole. It is the
      // only thing that says WHY, so it is shown rather than summarised.
      this.pushed.set({
        state: 'failed',
        detail: err instanceof Error ? err.message : String(err),
        url: this.status().url,
        model: this.status().model,
        external: false,
      });
    } finally {
      this.busy.set(false);
      this.changed.emit();
    }
  }

  protected async stop(): Promise<void> {
    if (!api) return;
    this.pushed.set(await api.pageReader.stop());
    this.changed.emit();
  }

  protected async saveKeepWarm(): Promise<void> {
    if (!api) return;
    // Answered with the value AS STORED, which is how the field learns it was
    // clamped rather than silently keeping a number main refused.
    this.keepWarm.set(await api.pageReader.setKeepWarm(Number(this.keepWarm()) || 0));
  }
}
