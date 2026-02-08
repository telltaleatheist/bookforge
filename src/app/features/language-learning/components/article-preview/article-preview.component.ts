import { Component, input, output, signal, computed, inject, OnInit, OnDestroy, effect, ElementRef, ViewChild, AfterViewInit, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';

/**
 * Minimal interface for Electron's webview tag
 * (Full types not available in Angular build)
 */
interface WebviewElement extends HTMLElement {
  executeJavaScript(script: string): Promise<unknown>;
}

/**
 * ArticlePreviewComponent - Visual element selection for web articles
 *
 * Uses an Electron webview to render the full HTML and allows clicking
 * on ANY element to mark it for deletion. Elements are tracked by their
 * unique CSS selector path.
 */
@Component({
  selector: 'app-article-preview',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="article-preview">
      <div class="preview-header">
        <div class="title-section">
          <h2>{{ title() || 'Article Preview' }}</h2>
          @if (byline()) {
            <p class="byline">{{ byline() }}</p>
          }
        </div>
        <div class="selection-stats">
          <span class="selection-badge" [class.hidden]="selectionCount() === 0">{{ selectionCount() }} selected</span>
          <span>{{ deletedCount() }} removed</span>
          <button class="btn-link" (click)="restoreAll()" [disabled]="deletedCount() === 0">
            Restore all
          </button>
        </div>
      </div>

      <div class="instructions">
        <span class="icon">i</span>
        <span class="instruction-text">
          Click or drag to select · ⌘+Click to add · Delete to remove · Select removed items + Delete to restore
        </span>
      </div>

      <div class="preview-content" #previewContainer>
        @if (isLoading()) {
          <div class="loading-state">
            <div class="spinner"></div>
            <p>Loading article...</p>
          </div>
        } @else if (error()) {
          <div class="error-state">
            <p>{{ error() }}</p>
          </div>
        } @else if (htmlPath()) {
          <!-- Webview renders the full HTML page -->
        }
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: block;
      height: 100%;
    }

    .article-preview {
      display: flex;
      flex-direction: column;
      height: 100%;
    }

    .preview-header {
      padding: 16px 24px;
      border-bottom: 1px solid var(--border-subtle);
      background: var(--bg-surface);
      display: flex;
      justify-content: space-between;
      align-items: flex-start;

      .title-section {
        flex: 1;
      }

      h2 {
        margin: 0 0 4px;
        font-size: 18px;
        color: var(--text-primary);
      }

      .byline {
        margin: 0;
        font-size: 13px;
        color: var(--text-secondary);
        font-style: italic;
      }
    }

    .selection-stats {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 13px;
      color: var(--text-secondary);
    }

    .selection-badge {
      padding: 4px 10px;
      border-radius: 12px;
      background: var(--accent, #06b6d4);
      color: white;
      font-size: 12px;
      font-weight: 500;

      &.hidden {
        visibility: hidden;
      }
    }

    .btn-link {
      background: none;
      border: none;
      color: var(--accent, #06b6d4);
      cursor: pointer;
      font-size: 13px;
      padding: 0;

      &:disabled {
        color: var(--text-muted);
        cursor: not-allowed;
      }

      &:hover:not(:disabled) {
        text-decoration: underline;
      }
    }

    .instructions {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 24px;
      background: var(--color-info-bg);
      color: var(--color-info);
      font-size: 12px;

      .icon {
        width: 16px;
        height: 16px;
        min-width: 16px;
        border-radius: 50%;
        background: var(--color-info);
        color: white;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 10px;
        font-weight: 600;
      }

      .instruction-text {
        opacity: 0.9;
      }
    }

    .preview-content {
      flex: 1;
      overflow: hidden;
      background: #f5f5f5;
      position: relative;
    }

    .loading-state, .error-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--text-secondary);
    }

    .spinner {
      width: 32px;
      height: 32px;
      border: 3px solid var(--border-default);
      border-top-color: var(--color-primary);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-bottom: 12px;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  `]
})
export class ArticlePreviewComponent implements OnInit, AfterViewInit, OnDestroy {
  private readonly sanitizer = inject(DomSanitizer);
  private readonly ngZone = inject(NgZone);

  @ViewChild('previewContainer') previewContainer!: ElementRef<HTMLDivElement>;

  // Inputs
  readonly htmlPath = input<string>('');
  readonly title = input<string>('');
  readonly byline = input<string>('');
  readonly wordCount = input<number>(0);
  readonly initialDeletedSelectors = input<string[]>([]);
  readonly initialUndoStack = input<{ type: string; selectors: string[]; timestamp: string }[]>([]);
  readonly initialRedoStack = input<{ type: string; selectors: string[]; timestamp: string }[]>([]);

  // Outputs
  readonly deletedSelectorsChange = output<string[]>();
  readonly undoStackChange = output<{ type: string; selectors: string[]; timestamp: string }[]>();
  readonly redoStackChange = output<{ type: string; selectors: string[]; timestamp: string }[]>();
  readonly projectChanged = output<void>();  // Signal to save project

  // State
  readonly isLoading = signal<boolean>(false);
  readonly error = signal<string | null>(null);
  readonly deletedSelectors = signal<Set<string>>(new Set());
  readonly selectionCount = signal<number>(0);
  readonly hasDeletedSelected = signal<boolean>(false);

  // Undo/Redo stacks
  private undoStack: { type: string; selectors: string[]; timestamp: string }[] = [];
  private redoStack: { type: string; selectors: string[]; timestamp: string }[] = [];
  readonly canUndo = signal<boolean>(false);
  readonly canRedo = signal<boolean>(false);

  // Computed
  readonly deletedCount = computed(() => this.deletedSelectors().size);

  private webview: WebviewElement | null = null;
  private webviewReady = false;

  constructor() {
    // Load initial deleted selectors
    effect(() => {
      const selectors = this.initialDeletedSelectors();
      if (selectors.length > 0) {
        this.deletedSelectors.set(new Set(selectors));
        // Re-apply deletions if webview is ready
        if (this.webviewReady) {
          this.applyDeletions();
        }
      }
    });

    // Load initial undo/redo stacks
    effect(() => {
      const undo = this.initialUndoStack();
      const redo = this.initialRedoStack();
      this.undoStack = [...undo];
      this.redoStack = [...redo];
      this.canUndo.set(this.undoStack.length > 0);
      this.canRedo.set(this.redoStack.length > 0);
    });

    // Create/update webview when htmlPath changes
    effect(() => {
      const path = this.htmlPath();
      if (path) {
        this.createWebview(path);
      }
    });
  }

  ngOnInit(): void {
    // Initial setup if needed
  }

  ngAfterViewInit(): void {
    // Create webview if htmlPath is already set
    const path = this.htmlPath();
    if (path) {
      this.createWebview(path);
    }
  }

  ngOnDestroy(): void {
    this.destroyWebview();
  }

  private createWebview(htmlPath: string): void {
    if (!this.previewContainer?.nativeElement) {
      return;
    }

    // Clean up existing webview
    this.destroyWebview();

    this.isLoading.set(true);

    // Create webview element
    const webview = document.createElement('webview') as WebviewElement;
    webview.setAttribute('src', `file://${htmlPath}`);
    webview.setAttribute('nodeintegration', 'false');
    webview.setAttribute('contextIsolation', 'true');
    webview.style.width = '100%';
    webview.style.height = '100%';
    webview.style.border = 'none';

    // Handle DOM ready
    webview.addEventListener('dom-ready', () => {
      this.ngZone.run(() => {
        this.onWebviewReady();
      });
    });

    // Handle console messages from webview (for debugging)
    webview.addEventListener('console-message', (e: Event & { message?: string }) => {
      console.log('[Webview]', e.message);
    });

    // Handle IPC messages from webview
    webview.addEventListener('ipc-message', (event: Event) => {
      this.ngZone.run(() => {
        this.handleWebviewMessage(event);
      });
    });

    // Handle load errors
    webview.addEventListener('did-fail-load', (e: Event & { errorCode?: number; errorDescription?: string }) => {
      this.ngZone.run(() => {
        if (e.errorCode !== -3) { // -3 is aborted, ignore
          this.error.set(`Failed to load article: ${e.errorDescription || 'Unknown error'}`);
          this.isLoading.set(false);
        }
      });
    });

    this.previewContainer.nativeElement.appendChild(webview);
    this.webview = webview;
  }

  private destroyWebview(): void {
    if (this.webview) {
      this.webview.remove();
      this.webview = null;
      this.webviewReady = false;
    }
  }

  private onWebviewReady(): void {
    this.webviewReady = true;
    this.isLoading.set(false);
    this.injectSelectionScript();
    this.applyDeletions();
  }

  /**
   * Inject JavaScript into webview to enable element selection
   * Uses selection-based deletion like PDF viewer:
   * - Click = select element
   * - Cmd+click (Mac) / Ctrl+click = add to selection
   * - Delete/Backspace = delete selected, or restore if deleted items selected
   */
  private injectSelectionScript(): void {
    if (!this.webview) return;

    const script = `
      (function() {
        // Track state
        let hoveredElement = null;
        const selectedElements = new Set();  // Currently selected elements

        // Generate unique CSS selector for an element
        function getSelector(el) {
          if (!el || el === document.body || el === document.documentElement) {
            return null;
          }

          // Try ID first
          if (el.id) {
            return '#' + CSS.escape(el.id);
          }

          // Build path from root
          const path = [];
          let current = el;

          while (current && current !== document.body && current !== document.documentElement) {
            let selector = current.tagName.toLowerCase();

            // Always add nth-of-type for uniqueness (even if there's only one sibling)
            // This prevents generating overly broad selectors like bare "p" when element
            // is a direct child of body with no siblings of the same type
            const parent = current.parentElement;
            if (parent) {
              const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
              const index = siblings.indexOf(current) + 1;
              selector += ':nth-of-type(' + index + ')';
            }

            path.unshift(selector);
            current = current.parentElement;
          }

          return path.join(' > ');
        }

        // Clear all selections
        function clearSelection() {
          selectedElements.forEach(el => {
            el.classList.remove('bf-selected');
          });
          selectedElements.clear();
          updateSelectionCount();
        }

        // Update selection count in parent
        function updateSelectionCount() {
          window.postMessage({
            type: 'selection-changed',
            count: selectedElements.size,
            hasDeletedSelected: Array.from(selectedElements).some(el => el.classList.contains('bf-deleted'))
          }, '*');
        }

        // Marquee selection state
        let isMarqueeSelecting = false;
        let marqueeStartX = 0;
        let marqueeStartY = 0;  // Document Y (includes scroll)
        let marqueeStartScrollY = 0;  // Scroll position at start
        let marqueeBox = null;
        let autoScrollInterval = null;
        let lastMouseY = 0;

        // Styles - using cyan accent color to match app theme
        const style = document.createElement('style');
        style.textContent = \`
          .bf-hover-highlight {
            outline: 2px dashed #06b6d4 !important;
            outline-offset: 2px !important;
            cursor: pointer !important;
          }
          .bf-selected {
            outline: 3px solid #06b6d4 !important;
            outline-offset: 2px !important;
            background-color: rgba(6, 182, 212, 0.12) !important;
          }
          .bf-deleted {
            position: relative !important;
            text-decoration: line-through !important;
            text-decoration-color: rgba(239, 68, 68, 0.7) !important;
            color: #888 !important;
          }
          .bf-deleted::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(239, 68, 68, 0.08);
            pointer-events: none;
            z-index: 1;
          }
          .bf-deleted::after {
            content: '✕ Removed';
            position: absolute;
            top: 4px;
            right: 4px;
            background: rgba(239, 68, 68, 0.9);
            color: white;
            padding: 2px 8px;
            border-radius: 4px;
            font-size: 11px;
            font-weight: 600;
            pointer-events: none;
            z-index: 10000;
          }
          .bf-deleted.bf-selected {
            outline: 3px solid #ef4444 !important;
            background-color: rgba(239, 68, 68, 0.15) !important;
          }
          /* Ensure children of deleted elements are NOT affected */
          .bf-deleted > * {
            text-decoration: none !important;
            color: inherit !important;
          }
          .bf-marquee {
            position: fixed;
            border: 2px solid #06b6d4;
            background: rgba(6, 182, 212, 0.12);
            pointer-events: none;
            z-index: 99999;
          }
          body.bf-marquee-active {
            cursor: crosshair !important;
            user-select: none !important;
          }
          body.bf-marquee-active * {
            cursor: crosshair !important;
          }
        \`;
        document.head.appendChild(style);

        // Check if element intersects with marquee rectangle (viewport coords)
        function elementIntersectsRect(el, rect) {
          const elRect = el.getBoundingClientRect();
          return !(elRect.right < rect.left ||
                   elRect.left > rect.right ||
                   elRect.bottom < rect.top ||
                   elRect.top > rect.bottom);
        }

        // Check if element intersects with marquee rectangle (document coords)
        function elementIntersectsDocRect(el, docRect) {
          const elRect = el.getBoundingClientRect();
          // Convert element rect to document coordinates
          const elDocRect = {
            left: elRect.left,
            right: elRect.right,
            top: elRect.top + window.scrollY,
            bottom: elRect.bottom + window.scrollY
          };
          return !(elDocRect.right < docRect.left ||
                   elDocRect.left > docRect.right ||
                   elDocRect.bottom < docRect.top ||
                   elDocRect.top > docRect.bottom);
        }

        // Get all selectable elements - focus on content elements, not containers
        // Exclude: div, section, article, ul, ol (these often contain mixed content)
        // Include: p, headings, li (individual items), figures, tables, links
        function getSelectableElements() {
          return document.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, img, figure, figcaption, blockquote, table, caption, pre, code, a');
        }

        // Mouseover handler
        document.addEventListener('mouseover', function(e) {
          if (isMarqueeSelecting) return;

          const target = e.target;
          if (target === document.body || target === document.documentElement) return;

          // Remove highlight from previous element
          if (hoveredElement && hoveredElement !== target) {
            hoveredElement.classList.remove('bf-hover-highlight');
          }

          // Don't show hover on selected elements (already highlighted)
          if (!target.classList.contains('bf-selected')) {
            hoveredElement = target;
            target.classList.add('bf-hover-highlight');
          }
        }, true);

        // Mouseout handler
        document.addEventListener('mouseout', function(e) {
          if (isMarqueeSelecting) return;

          if (hoveredElement) {
            hoveredElement.classList.remove('bf-hover-highlight');
            hoveredElement = null;
          }
        }, true);

        // Mousedown - start marquee or prepare for click
        document.addEventListener('mousedown', function(e) {
          if (e.button !== 0) return;  // Only left click

          // Start marquee selection - store document position (not viewport)
          isMarqueeSelecting = true;
          marqueeStartX = e.clientX;
          marqueeStartY = e.clientY + window.scrollY;  // Document Y coordinate
          marqueeStartScrollY = window.scrollY;

          // Create marquee box
          marqueeBox = document.createElement('div');
          marqueeBox.className = 'bf-marquee';
          marqueeBox.style.left = e.clientX + 'px';
          marqueeBox.style.top = e.clientY + 'px';
          marqueeBox.style.width = '0px';
          marqueeBox.style.height = '0px';
          document.body.appendChild(marqueeBox);
          document.body.classList.add('bf-marquee-active');
        });

        // Auto-scroll function
        function startAutoScroll() {
          if (autoScrollInterval) return;

          autoScrollInterval = setInterval(function() {
            if (!isMarqueeSelecting) {
              stopAutoScroll();
              return;
            }

            const viewportHeight = window.innerHeight;
            const scrollSpeed = 15;
            const edgeThreshold = 60;

            // Scroll down if mouse is near bottom or below viewport
            if (lastMouseY > viewportHeight - edgeThreshold) {
              const intensity = Math.min((lastMouseY - (viewportHeight - edgeThreshold)) / edgeThreshold, 2);
              window.scrollBy(0, scrollSpeed * intensity);
            }
            // Scroll up if mouse is near top or above viewport
            else if (lastMouseY < edgeThreshold) {
              const intensity = Math.min((edgeThreshold - lastMouseY) / edgeThreshold, 2);
              window.scrollBy(0, -scrollSpeed * intensity);
            }

            // Update marquee position after scroll
            updateMarqueePosition();
          }, 16); // ~60fps
        }

        function stopAutoScroll() {
          if (autoScrollInterval) {
            clearInterval(autoScrollInterval);
            autoScrollInterval = null;
          }
        }

        let lastMouseX = 0;

        // Update marquee box position based on document coordinates
        function updateMarqueePosition() {
          if (!marqueeBox) return;

          // Current mouse position in document coordinates
          const currentDocY = lastMouseY + window.scrollY;

          // Calculate rectangle in document coordinates
          const docLeft = Math.min(lastMouseX, marqueeStartX);
          const docTop = Math.min(currentDocY, marqueeStartY);
          const docRight = Math.max(lastMouseX, marqueeStartX);
          const docBottom = Math.max(currentDocY, marqueeStartY);

          // Convert to viewport coordinates for display
          const viewportTop = docTop - window.scrollY;
          const viewportBottom = docBottom - window.scrollY;

          // Clamp to visible viewport
          const visibleTop = Math.max(0, viewportTop);
          const visibleBottom = Math.min(window.innerHeight, viewportBottom);

          marqueeBox.style.left = docLeft + 'px';
          marqueeBox.style.top = visibleTop + 'px';
          marqueeBox.style.width = (docRight - docLeft) + 'px';
          marqueeBox.style.height = Math.max(0, visibleBottom - visibleTop) + 'px';
        }

        // Mousemove - update marquee and trigger auto-scroll
        document.addEventListener('mousemove', function(e) {
          lastMouseX = e.clientX;
          lastMouseY = e.clientY;

          if (!isMarqueeSelecting || !marqueeBox) return;

          updateMarqueePosition();

          // Start auto-scroll if near edges
          const viewportHeight = window.innerHeight;
          const edgeThreshold = 60;
          if (e.clientY > viewportHeight - edgeThreshold || e.clientY < edgeThreshold) {
            startAutoScroll();
          } else {
            stopAutoScroll();
          }
        });

        // Mouseup - finish marquee or handle click
        document.addEventListener('mouseup', function(e) {
          stopAutoScroll();  // Stop any auto-scrolling

          if (!isMarqueeSelecting) return;

          const width = Math.abs(e.clientX - marqueeStartX);
          const height = Math.abs(e.clientY - marqueeStartY);
          const isMultiSelect = e.metaKey || e.ctrlKey || e.shiftKey;

          // If it was a small movement, treat as click
          if (width < 5 && height < 5) {
            // Remove marquee box
            if (marqueeBox) {
              marqueeBox.remove();
              marqueeBox = null;
            }
            document.body.classList.remove('bf-marquee-active');
            isMarqueeSelecting = false;

            // Handle as click
            const target = document.elementFromPoint(e.clientX, e.clientY);
            if (!target || target === document.body || target === document.documentElement) {
              // Clicked on empty space - clear selection
              if (!isMultiSelect) {
                clearSelection();
              }
              return;
            }

            if (isMultiSelect) {
              // Toggle selection on this element
              if (selectedElements.has(target)) {
                target.classList.remove('bf-selected');
                selectedElements.delete(target);
              } else {
                target.classList.remove('bf-hover-highlight');
                target.classList.add('bf-selected');
                selectedElements.add(target);
              }
            } else {
              // Single click - clear others and select this one
              clearSelection();
              target.classList.remove('bf-hover-highlight');
              target.classList.add('bf-selected');
              selectedElements.add(target);
            }

            updateSelectionCount();
            return;
          }

          // It's a marquee selection - calculate in document coordinates
          const currentDocY = e.clientY + window.scrollY;
          const marqueeDocRect = {
            left: Math.min(e.clientX, marqueeStartX),
            top: Math.min(currentDocY, marqueeStartY),
            right: Math.max(e.clientX, marqueeStartX),
            bottom: Math.max(currentDocY, marqueeStartY)
          };

          // Clear selection if not multi-select
          if (!isMultiSelect) {
            clearSelection();
          }

          // Find all elements in the marquee (using document coordinates)
          const elements = getSelectableElements();
          const candidateElements = [];

          elements.forEach(el => {
            if (elementIntersectsDocRect(el, marqueeDocRect)) {
              candidateElements.push(el);
            }
          });

          // Filter out parent elements if their children are also candidates
          // This ensures we select the most specific elements only
          const filteredElements = candidateElements.filter(el => {
            // Check if any other candidate is a child of this element
            const hasChildCandidate = candidateElements.some(other =>
              other !== el && el.contains(other)
            );
            return !hasChildCandidate;
          });

          // Add filtered elements to selection
          filteredElements.forEach(el => {
            el.classList.add('bf-selected');
            selectedElements.add(el);
          });

          // Clean up
          if (marqueeBox) {
            marqueeBox.remove();
            marqueeBox = null;
          }
          document.body.classList.remove('bf-marquee-active');
          isMarqueeSelecting = false;

          updateSelectionCount();
        });

        // Keyboard handler - Delete/Backspace
        document.addEventListener('keydown', function(e) {
          if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();

            if (selectedElements.size === 0) return;

            // Check if any selected elements are already deleted
            const hasDeleted = Array.from(selectedElements).some(el => el.classList.contains('bf-deleted'));

            if (hasDeleted) {
              // Restore deleted elements - collect all selectors first
              const restoredSelectors = [];
              selectedElements.forEach(el => {
                if (el.classList.contains('bf-deleted')) {
                  el.classList.remove('bf-deleted');
                  const selector = getSelector(el);
                  if (selector) {
                    restoredSelectors.push(selector);
                  }
                }
              });
              // Send batch restore message
              if (restoredSelectors.length > 0) {
                window.postMessage({ type: 'batch-restore', selectors: restoredSelectors }, '*');
              }
            } else {
              // Filter out parent elements if their children are also selected
              const selectedArray = Array.from(selectedElements);
              const filteredForDelete = selectedArray.filter(el => {
                const hasChildSelected = selectedArray.some(other =>
                  other !== el && el.contains(other)
                );
                return !hasChildSelected;
              });

              // Delete only the most specific (leaf) elements - collect all selectors first
              const deletedSelectors = [];
              filteredForDelete.forEach(el => {
                el.classList.add('bf-deleted');
                const selector = getSelector(el);
                if (selector) {
                  deletedSelectors.push(selector);
                }
              });
              // Send batch delete message
              if (deletedSelectors.length > 0) {
                window.postMessage({ type: 'batch-delete', selectors: deletedSelectors }, '*');
              }
            }

            // Clear selection after action
            clearSelection();
          }

          // Escape to clear selection
          if (e.key === 'Escape') {
            clearSelection();
          }

          // Cmd+Z / Ctrl+Z to undo
          if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
            e.preventDefault();
            window.postMessage({ type: 'undo-request' }, '*');
          }

          // Cmd+Shift+Z / Ctrl+Shift+Z to redo
          if ((e.metaKey || e.ctrlKey) && e.key === 'z' && e.shiftKey) {
            e.preventDefault();
            window.postMessage({ type: 'redo-request' }, '*');
          }

          // Cmd+A / Ctrl+A to select all (non-deleted)
          if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
            e.preventDefault();
            clearSelection();
            getSelectableElements().forEach(el => {
              if (!el.classList.contains('bf-deleted')) {
                el.classList.add('bf-selected');
                selectedElements.add(el);
              }
            });
            updateSelectionCount();
          }
        });

        // Listen for commands from parent
        window.addEventListener('message', function(e) {
          if (e.data && e.data.type === 'restore-all') {
            document.querySelectorAll('.bf-deleted').forEach(el => {
              el.classList.remove('bf-deleted');
            });
            clearSelection();
          } else if (e.data && e.data.type === 'apply-deletions') {
            const selectors = e.data.selectors || [];
            selectors.forEach(selector => {
              try {
                const el = document.querySelector(selector);
                if (el) {
                  el.classList.add('bf-deleted');
                }
              } catch (err) {
                console.warn('Invalid selector:', selector);
              }
            });
          } else if (e.data && e.data.type === 'apply-restore') {
            // Apply restore from undo operation
            const selectors = e.data.selectors || [];
            selectors.forEach(selector => {
              try {
                const el = document.querySelector(selector);
                if (el) {
                  el.classList.remove('bf-deleted');
                }
              } catch (err) {
                console.warn('Invalid selector:', selector);
              }
            });
          } else if (e.data && e.data.type === 'delete-selected') {
            // Programmatic delete of selection
            const selectedArray = Array.from(selectedElements);
            const filteredForDelete = selectedArray.filter(el => {
              const hasChildSelected = selectedArray.some(other =>
                other !== el && el.contains(other)
              );
              return !hasChildSelected;
            });

            const deletedSelectors = [];
            filteredForDelete.forEach(el => {
              if (!el.classList.contains('bf-deleted')) {
                el.classList.add('bf-deleted');
                const selector = getSelector(el);
                if (selector) {
                  deletedSelectors.push(selector);
                }
              }
            });
            if (deletedSelectors.length > 0) {
              window.postMessage({ type: 'batch-delete', selectors: deletedSelectors }, '*');
            }
            clearSelection();
          }
        });

        console.log('[ArticlePreview] Selection script injected (selection-based deletion)');
      })();
    `;

    this.webview.executeJavaScript(script).catch((err: unknown) => {
      console.error('Failed to inject selection script:', err);
    });

    // Set up message listener for postMessage from webview
    this.webview.executeJavaScript(`
      window.addEventListener('message', function(e) {
        if (e.data && e.data.type) {
          // Forward all recognized message types to parent via console (hacky but works without preload)
          const knownTypes = ['element-deleted', 'element-restored', 'selection-changed', 'batch-delete', 'batch-restore', 'undo-request', 'redo-request'];
          if (knownTypes.includes(e.data.type)) {
            console.log('__IPC__' + JSON.stringify(e.data));
          }
        }
      });
    `);

    // Listen for console messages that are actually IPC
    this.webview.addEventListener('console-message', (event: Event & { message?: string }) => {
      if (event.message?.startsWith('__IPC__')) {
        try {
          const data = JSON.parse(event.message.substring(7));
          this.ngZone.run(() => {
            this.handleElementMessage(data);
          });
        } catch {
          // Not an IPC message
        }
      }
    });
  }

  private handleWebviewMessage(_event: Event): void {
    // Handle IPC messages if we add a preload script
  }

  private handleElementMessage(data: { type: string; selector?: string; selectors?: string[]; count?: number; hasDeletedSelected?: boolean }): void {
    if (data.type === 'selection-changed') {
      // Update selection state
      this.selectionCount.set(data.count || 0);
      this.hasDeletedSelected.set(data.hasDeletedSelected || false);
      return;
    }

    // Handle undo/redo requests
    if (data.type === 'undo-request') {
      this.undo();
      return;
    }
    if (data.type === 'redo-request') {
      this.redo();
      return;
    }

    const current = new Set(this.deletedSelectors());

    // Handle batch operations
    if (data.type === 'batch-delete' && data.selectors) {
      const selectors = data.selectors as string[];
      selectors.forEach(s => current.add(s));

      // Record action for undo
      this.undoStack.push({
        type: 'delete',
        selectors: selectors,
        timestamp: new Date().toISOString()
      });
      // Clear redo stack on new action
      this.redoStack = [];
      this.updateUndoRedoState();

      this.deletedSelectors.set(current);
      this.emitChanges();
      return;
    }

    if (data.type === 'batch-restore' && data.selectors) {
      const selectors = data.selectors as string[];
      selectors.forEach(s => current.delete(s));

      // Record action for undo
      this.undoStack.push({
        type: 'restore',
        selectors: selectors,
        timestamp: new Date().toISOString()
      });
      // Clear redo stack on new action
      this.redoStack = [];
      this.updateUndoRedoState();

      this.deletedSelectors.set(current);
      this.emitChanges();
      return;
    }

    // Legacy single-element handlers (for backwards compatibility)
    if (data.type === 'element-deleted' && data.selector) {
      current.add(data.selector);
    } else if (data.type === 'element-restored' && data.selector) {
      current.delete(data.selector);
    }

    this.deletedSelectors.set(current);
    this.deletedSelectorsChange.emit(Array.from(current));
  }

  private updateUndoRedoState(): void {
    this.canUndo.set(this.undoStack.length > 0);
    this.canRedo.set(this.redoStack.length > 0);
  }

  private emitChanges(): void {
    this.deletedSelectorsChange.emit(Array.from(this.deletedSelectors()));
    this.undoStackChange.emit([...this.undoStack]);
    this.redoStackChange.emit([...this.redoStack]);
    this.projectChanged.emit();
  }

  undo(): void {
    if (this.undoStack.length === 0) return;

    const action = this.undoStack.pop()!;
    const current = new Set(this.deletedSelectors());

    if (action.type === 'delete') {
      // Undo delete = restore
      action.selectors.forEach(s => current.delete(s));
      // Apply visually in webview
      if (this.webview && this.webviewReady) {
        this.webview.executeJavaScript(`
          window.postMessage({ type: 'apply-restore', selectors: ${JSON.stringify(action.selectors)} }, '*');
        `).catch(console.error);
      }
    } else {
      // Undo restore = delete
      action.selectors.forEach(s => current.add(s));
      // Apply visually in webview
      if (this.webview && this.webviewReady) {
        this.webview.executeJavaScript(`
          window.postMessage({ type: 'apply-deletions', selectors: ${JSON.stringify(action.selectors)} }, '*');
        `).catch(console.error);
      }
    }

    // Move to redo stack
    this.redoStack.push(action);
    this.updateUndoRedoState();

    this.deletedSelectors.set(current);
    this.emitChanges();
  }

  redo(): void {
    if (this.redoStack.length === 0) return;

    const action = this.redoStack.pop()!;
    const current = new Set(this.deletedSelectors());

    if (action.type === 'delete') {
      // Redo delete = delete again
      action.selectors.forEach(s => current.add(s));
      // Apply visually in webview
      if (this.webview && this.webviewReady) {
        this.webview.executeJavaScript(`
          window.postMessage({ type: 'apply-deletions', selectors: ${JSON.stringify(action.selectors)} }, '*');
        `).catch(console.error);
      }
    } else {
      // Redo restore = restore again
      action.selectors.forEach(s => current.delete(s));
      // Apply visually in webview
      if (this.webview && this.webviewReady) {
        this.webview.executeJavaScript(`
          window.postMessage({ type: 'apply-restore', selectors: ${JSON.stringify(action.selectors)} }, '*');
        `).catch(console.error);
      }
    }

    // Move back to undo stack
    this.undoStack.push(action);
    this.updateUndoRedoState();

    this.deletedSelectors.set(current);
    this.emitChanges();
  }

  private applyDeletions(): void {
    if (!this.webview || !this.webviewReady) return;

    const selectors = Array.from(this.deletedSelectors());
    this.webview.executeJavaScript(`
      window.postMessage({ type: 'apply-deletions', selectors: ${JSON.stringify(selectors)} }, '*');
    `).catch((err: unknown) => {
      console.error('Failed to apply deletions:', err);
    });
  }

  restoreAll(): void {
    if (this.webview && this.webviewReady) {
      this.webview.executeJavaScript(`
        window.postMessage({ type: 'restore-all' }, '*');
      `).catch((err: unknown) => {
        console.error('Failed to restore all:', err);
      });
    }
    this.deletedSelectors.set(new Set());
    this.deletedSelectorsChange.emit([]);
  }

  /**
   * Get the filtered HTML content with deleted elements removed
   */
  async getFilteredHtml(): Promise<string> {
    if (!this.webview || !this.webviewReady) {
      return '';
    }

    const selectors = Array.from(this.deletedSelectors());

    // Execute in webview to get HTML with deleted elements removed
    const html = await this.webview.executeJavaScript(`
      (function() {
        // Clone the document
        const clone = document.documentElement.cloneNode(true);

        // Remove deleted elements
        const selectors = ${JSON.stringify(selectors)};
        selectors.forEach(selector => {
          try {
            const el = clone.querySelector(selector);
            if (el) {
              el.remove();
            }
          } catch (err) {}
        });

        // Remove our injected styles and classes
        clone.querySelectorAll('.bf-hover-highlight, .bf-deleted').forEach(el => {
          el.classList.remove('bf-hover-highlight', 'bf-deleted');
        });
        const injectedStyle = clone.querySelector('style');
        if (injectedStyle && injectedStyle.textContent.includes('bf-hover-highlight')) {
          injectedStyle.remove();
        }

        return clone.outerHTML;
      })();
    `) as string;

    return html;
  }

  /**
   * Get plain text content with deleted elements removed
   */
  async getFilteredText(): Promise<string> {
    if (!this.webview || !this.webviewReady) {
      return '';
    }

    const selectors = Array.from(this.deletedSelectors());

    const text = await this.webview.executeJavaScript(`
      (function() {
        // Clone the body
        const clone = document.body.cloneNode(true);

        // Remove deleted elements
        const selectors = ${JSON.stringify(selectors)};
        selectors.forEach(selector => {
          try {
            // Adjust selector for body context
            const bodySelector = selector.replace(/^html\\s*>\\s*body\\s*>\\s*/, '');
            const el = clone.querySelector(bodySelector) || clone.querySelector(selector);
            if (el) {
              el.remove();
            }
          } catch (err) {}
        });

        // Remove script and style elements
        clone.querySelectorAll('script, style, noscript').forEach(el => el.remove());

        return clone.textContent.replace(/\\s+/g, ' ').trim();
      })();
    `) as string;

    return text;
  }
}
