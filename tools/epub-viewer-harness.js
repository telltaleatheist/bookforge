#!/usr/bin/env node
/**
 * Run the EPUB viewer's bench, and nothing else of BookForge.
 *
 *   npx ng serve --port 4266
 *   npx tsc -p tsconfig.electron.json && npm run build:quire-vendor
 *   node tools/epub-viewer-harness.js <book.epub> [--port 4266] [--measure out.json]
 *
 * The route `/#/epub-viewer-harness` lives in the app and Phase C will reach it
 * the ordinary way. This launcher exists so the component can be driven WITHOUT
 * starting the whole app: it registers the one scheme quire needs, wires the two
 * IPC handles the bench calls, opens one window at that route, and gets out of
 * the way. `electron/main.ts` does the same three things for the product.
 *
 * `--measure` drives the bench from the outside afterwards — scroll the whole
 * book, count what is mounted, strike blocks, read the marks back off the live
 * pages — and writes the numbers out. That is the part that proves the viewer
 * works on the real book rather than merely starts.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

if (!process.versions.electron) {
  const electron = require(path.join(__dirname, '..', 'node_modules', 'electron'));
  const result = spawnSync(electron, [__filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });
  process.exit(result.status === null ? 1 : result.status);
}

const { app, BrowserWindow } = require('electron');
const DIST = path.join(__dirname, '..', 'dist');
const { Quire } = require(path.join(DIST, 'packages/quire/src/index.js'));
const { setupQuireViewerIpc } = require(path.join(DIST, 'electron/quire-viewer-bridge.js'));

Quire.registerScheme();

const argv = process.argv.slice(process.argv.indexOf(__filename) + 1);
let bookPath = null;
let port = 4266;
let measureOut = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--port') { port = Number(argv[++i]); continue; }
  if (argv[i] === '--measure') { measureOut = argv[++i]; continue; }
  if (!bookPath) bookPath = argv[i];
}
if (!bookPath) {
  console.error('usage: node tools/epub-viewer-harness.js <book.epub> [--port 4266] [--measure out.json]');
  process.exit(2);
}

const ms = (n) => Math.round(n * 10) / 10;
const pct = (sorted, p) => (sorted.length === 0 ? null
  : ms(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]));

app.on('window-all-closed', () => app.quit());

app.whenReady().then(async () => {
  setupQuireViewerIpc();

  const win = new BrowserWindow({
    width: 1500,
    height: 1000,
    show: true,
    title: 'EPUB viewer bench',
    webPreferences: {
      preload: path.join(DIST, 'electron/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The bench mounts the book in <webview>s, exactly as the picker window
      // will — electron/main.ts already sets this on the app window.
      webviewTag: true,
    },
  });
  win.webContents.on('console-message', (_e, _level, message) => {
    console.log(`[bench] ${message}`);
  });

  const url = `http://localhost:${port}/#/epub-viewer-harness?book=${encodeURIComponent(bookPath)}`;
  console.log(`[harness] ${url}`);
  await win.loadURL(url);

  if (!measureOut) return;

  // Partial results are results. A step that could not run is written down as a
  // step that could not run, beside the ones that did, rather than taking the
  // whole measurement with it.
  const measurements = { failures: [] };
  try {
    await measure(win, `#/epub-viewer-harness?book=${encodeURIComponent(bookPath)}`, measurements);
  } catch (err) {
    measurements.failures.push(String((err && err.message) || err));
    console.error('[harness] measurement stopped:', err);
  }
  fs.writeFileSync(measureOut, JSON.stringify(measurements, null, 2), 'utf8');
  console.log(`[harness] measurements written to ${measureOut}`);
  console.log(JSON.stringify(measurements, null, 2));
  app.exit(measurements.failures.length === 0 ? 0 : 1);
});

function inPage(win, expression, label, timeoutMs = 120000) {
  return Promise.race([
    win.webContents.executeJavaScript(expression, true),
    new Promise((_r, reject) => setTimeout(
      () => reject(new Error(`${label}: no answer within ${timeoutMs} ms`)), timeoutMs)),
  ]);
}

/**
 * Drive the bench from the outside and write down what it did.
 *
 * Everything here is asked of the LIVE page — how many pages are mounted, what
 * classes the book's own elements are wearing, how long a frame took to come up
 * — so that the numbers are the viewer's rather than the harness's idea of it.
 */
async function measure(win, hash, out) {

  // The bench opens the book itself from the query parameter, but it opens on a
  // click; press it from here and wait for the viewer to exist.
  const opened = await inPage(win, `(async () => {
    // Two things have to settle before the bench exists. loadURL resolves when
    // the DOCUMENT has loaded, but Angular then bootstraps and fetches the
    // route's own chunk; and on a fresh origin the shell sends the user to
    // first-run setup, because localStorage is per-origin and this bench is not
    // served on the app's port. The route is simply re-asserted until it sticks
    // — the bench's route has no library guard, so it does.
    const want = ${JSON.stringify(hash)};
    let button = null;
    for (let i = 0; i < 400; i++) {
      button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Open');
      if (button) break;
      if (location.hash !== want) location.hash = want;
      await new Promise(r => setTimeout(r, 100));
    }
    if (!button) {
      return { error: 'the bench has no Open button',
        hash: location.hash,
        components: [...new Set([...document.querySelectorAll('*')]
          .map(e => e.tagName.toLowerCase()).filter(t => t.startsWith('app-')))],
        buttons: [...document.querySelectorAll('button')].map(b => b.textContent.trim()).slice(0, 20),
        bodyText: document.body.innerText.slice(0, 400) };
    }
    button.click();
    return true;
  })()`, 'open');
  if (opened && opened.error) {
    throw new Error(`${opened.error} — hash ${opened.hash}, components `
      + `${JSON.stringify(opened.components)}, buttons ${JSON.stringify(opened.buttons)}, `
      + `body "${opened.bodyText}"`);
  }

  const t0 = Date.now();
  out.timeToFirstPageMs = await inPage(win, `(async () => {
    const started = performance.now();
    for (let i = 0; i < 1200; i++) {
      // A mounted, arranged frame is the one that has page labels drawn over it.
      if (document.querySelector('app-epub-viewer .page-label')) return Math.round(performance.now() - started);
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('no page was shown within 60 s');
  })()`, 'first page');
  out.openAndFirstPageMs = Date.now() - t0;

  const shape = await inPage(win, `(() => {
    const stat = document.querySelector('.bar .stat');
    return { stats: stat ? stat.textContent.replace(/\\s+/g, ' ').trim() : null,
             bands: document.querySelectorAll('[data-band]').length };
  })()`, 'shape');
  Object.assign(out, shape);

  // ── scroll the whole book ────────────────────────────────────────────────
  out.scroll = await inPage(win, `(async () => {
    const viewport = document.querySelector('.epub-viewport');
    if (!viewport) throw new Error('no viewport');
    const frames = [];
    let peakWebviews = 0;
    let peakNodes = 0;
    let last = performance.now();
    viewport.scrollTop = 0;
    while (viewport.scrollTop + viewport.clientHeight < viewport.scrollHeight - 1) {
      viewport.scrollTop += Math.round(viewport.clientHeight * 0.8);
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      // Give a newly-visible chapter a moment to lay itself out — it only can
      // while it is on screen, which is exactly where it is now.
      await new Promise(r => setTimeout(r, 250));
      const now = performance.now();
      frames.push(now - last);
      last = now;
      peakWebviews = Math.max(peakWebviews, document.querySelectorAll('app-epub-viewer webview').length);
      peakNodes = Math.max(peakNodes, document.querySelectorAll('app-epub-viewer *').length);
    }
    return {
      frames,
      steps: frames.length,
      peakMountedFrames: peakWebviews,
      peakViewerDomNodes: peakNodes,
      scrollHeightPx: Math.round(viewport.scrollHeight),
      pagesLabelled: document.querySelectorAll('app-epub-viewer .page-label').length,
      refusedBands: [...document.querySelectorAll('.band-status.refused')].map(e => e.textContent.trim()),
    };
  })()`, 'scroll through book', 600000);

  out.heapMb = Math.round(await inPage(
    win, '(performance.memory ? performance.memory.usedJSHeapSize : 0)', 'heap') / 1048576);
  out.allProcessesWorkingSetMb = Math.round(
    app.getAppMetrics().reduce((s, m) => s + (m.memory?.workingSetSize || 0), 0) / 1024);

  // ── to a text chapter, then the gestures ─────────────────────────────────
  //
  // Deliberately NOT the cover: its one element is a full-bleed plate, so every
  // click lands on it and a marquee would have nothing to select that a click
  // had not already. A prose chapter is where the picker's gestures actually
  // have to work.
  out.gestureBand = await inPage(win, `(async () => {
    const viewport = document.querySelector('.epub-viewport');
    const bands = [...document.querySelectorAll('[data-band]')];
    // The first band tall enough to hold several pages is a chapter, not
    // front matter.
    const band = bands.find(b => b.getBoundingClientRect().height > viewport.clientHeight * 2)
      ?? bands[Math.min(6, bands.length - 1)];
    band.scrollIntoView();
    viewport.scrollTop -= 20;
    for (let i = 0; i < 200; i++) {
      if (band.querySelector('.page-label')) break;
      await new Promise(r => setTimeout(r, 100));
    }
    return { index: Number(band.dataset.band), mounted: !!band.querySelector('.page-label'),
             pages: band.querySelectorAll('.page-label').length,
             // The component says what each band is doing; ask it rather than guess.
             status: band.querySelector('.band-status') ? band.querySelector('.band-status').textContent.trim() : null,
             allBandStatuses: [...document.querySelectorAll('[data-band]')].map(b => ({
               band: Number(b.dataset.band),
               frames: b.querySelectorAll('webview').length,
               status: b.querySelector('.band-status') ? b.querySelector('.band-status').textContent.trim().slice(0, 80) : 'ready',
             })) };
  })()`, 'to a chapter', 180000);

  // A click on a real element: aim at the middle of the first page's overlay and
  // walk down until something is hit.
  out.click = await inPage(win, `(async () => {
    const band = document.querySelector('[data-band="' + ${out.gestureBand.index} + '"]');
    const overlay = band.querySelector('.band-overlay');
    if (!overlay) throw new Error('no overlay');
    const box = overlay.getBoundingClientRect();
    for (let dy = 40; dy < Math.min(880, box.height); dy += 12) {
      const before = document.querySelector('.bar .stat + .spacer') ? null : null;
      overlay.dispatchEvent(new MouseEvent('mousedown', {
        clientX: box.left + box.width * 0.35, clientY: box.top + dy, button: 0, bubbles: true }));
      await new Promise(r => setTimeout(r, 60));
      const marks = document.querySelectorAll('app-epub-viewer webview').length;
      const status = [...document.querySelectorAll('footer .stat')].map(e => e.textContent.trim());
      if (status.some(s => s.startsWith('click '))) {
        return { hitAtY: dy, event: status.find(s => s.startsWith('click ')), frames: marks };
      }
    }
    return { error: 'no element was hit anywhere down the page',
      band: ${out.gestureBand.index},
      overlayBox: {left: Math.round(box.left), top: Math.round(box.top),
                   width: Math.round(box.width), height: Math.round(box.height)},
      webviews: band.querySelectorAll('webview').length,
      pageLabels: band.querySelectorAll('.page-label').length,
      status: [...document.querySelectorAll('footer .stat')].map(e => e.textContent.trim()) };
  })()`, 'click');

  // Strike what is selected, then read the marks back OFF THE BOOK'S OWN DOM.
  out.strike = await inPage(win, `(async () => {
    const strike = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Strike') && !b.disabled);
    if (!strike) throw new Error('nothing selected to strike');
    strike.click();
    await new Promise(r => setTimeout(r, 500));
    const band = document.querySelector('[data-band="' + ${out.gestureBand.index} + '"]');
    const frame = band.querySelector('webview');
    const raw = await frame.executeJavaScript(
      '(function(){return JSON.stringify({' +
      'struck: document.querySelectorAll(".bf-struck").length,' +
      'selected: document.querySelectorAll(".bf-selected").length,' +
      'sheet: !!document.getElementById("bf-quire-view-style"),' +
      'scripts: document.querySelectorAll("script").length});})()');
    return JSON.parse(raw);
  })()`, 'strike');

  // Marquee over the top-left quarter of the first band.
  out.marquee = await inPage(win, `(async () => {
    const band = document.querySelector('[data-band="' + ${out.gestureBand.index} + '"]');
    const overlay = band.querySelector('.band-overlay');
    const box = overlay.getBoundingClientRect();
    const send = (type, x, y) => overlay.dispatchEvent(new MouseEvent(type, {
      clientX: x, clientY: y, button: 0, bubbles: true }));
    // Start in the page's outer margin, which no element covers, so this is a
    // marquee and not a click on whatever happens to be at the corner.
    send('mousedown', box.left + 2, box.top + 2);
    send('mousemove', box.left + box.width * 0.8, box.top + 620);
    send('mouseup', box.left + box.width * 0.8, box.top + 620);
    await new Promise(r => setTimeout(r, 300));
    const status = [...document.querySelectorAll('footer .stat')].map(e => e.textContent.trim());
    return { event: status.find(s => s.startsWith('marquee')) ?? status.join(' | ') };
  })()`, 'marquee');

  // Exclude a page, and check the page box itself wears the mark.
  out.pageDelete = await inPage(win, `(async () => {
    const band = document.querySelector('[data-band="' + ${out.gestureBand.index} + '"]');
    const button = band.querySelector('.page-delete');
    if (!button) throw new Error('no page-exclude control');
    button.click();
    await new Promise(r => setTimeout(r, 400));
    const frame = band.querySelector('webview');
    const raw = await frame.executeJavaScript(
      '(function(){return JSON.stringify({struckPages: document.querySelectorAll(".bf-page-struck").length});})()');
    return { ...JSON.parse(raw), excludedBadges: document.querySelectorAll('.deleted-badge').length };
  })()`, 'page delete');

  // Zoom: pagination identity must not change with it.
  out.zoom = await inPage(win, `(async () => {
    const band = document.querySelector('[data-band="' + ${out.gestureBand.index} + '"]');
    const before = band.querySelectorAll('.page-label').length;
    const plus = [...document.querySelectorAll('label')].find(l => l.textContent.includes('Zoom'))
      .querySelectorAll('button')[1];
    for (let i = 0; i < 5; i++) plus.click();
    await new Promise(r => setTimeout(r, 600));
    const after = band.querySelectorAll('.page-label').length;
    const frame = band.querySelector('webview');
    const raw = await frame.executeJavaScript(
      '(function(){var c=document.querySelector(".pagedjs_pages");return JSON.stringify({' +
      'transform: c ? c.style.transform : null,' +
      'pageBoxes: document.querySelectorAll(".pagedjs_page").length});})()');
    return { labelsBefore: before, labelsAfter: after, ...JSON.parse(raw) };
  })()`, 'zoom');

  const frameTimes = (out.scroll.frames ?? []).slice().sort((a, b) => a - b);
  out.scrollStepMsP50 = pct(frameTimes, 50);
  out.scrollStepMsP95 = pct(frameTimes, 95);
  return out;
}
