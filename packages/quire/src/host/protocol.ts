/**
 * `quire://<session>/<zip entry>` — the ONLY way book bytes reach the renderer.
 *
 * The book is untrusted content. Nothing it references may be fetched from
 * anywhere except the archive it came in, and nothing outside that archive may
 * be reachable by asking for it cleverly. Two independent mechanisms enforce
 * that, so neither is a single point of failure:
 *
 *  1. This handler serves names out of a Map built from the ZIP central
 *     directory. There is no filesystem path anywhere in the lookup, so there is
 *     no path to escape from — `..` cannot reach a directory because there are
 *     no directories.
 *  2. Traversal syntax is refused outright rather than normalised away.
 *     Normalising `a/../../b` down to `b` and then serving it is how an
 *     implementation "handles" traversal and still surprises somebody. A request
 *     containing a `..` segment, a backslash, a drive letter or a NUL is a 403,
 *     named as such.
 *
 * On top of that, {@link attachQuireProtocol} cancels every request that is not
 * `quire:` (so a book cannot phone home even if a CSP were mis-typed) and denies
 * every permission request.
 *
 * House pattern: this follows `bookforge-page://` in `electron/main.ts` — new
 * `protocol.handle` API, privileged scheme registered before app ready — with
 * the path checks that one does not have, because that one serves BookForge's
 * own cache and this one serves a stranger's markup.
 */
import { quireFail } from '../errors';
import type { QuireArchive } from '../epub/archive';

export const QUIRE_SCHEME = 'quire';

let schemeRegistered = false;

/**
 * Register the `quire` scheme as privileged. MUST be called at module scope,
 * before `app.whenReady()`, exactly like `bookforge-page`.
 *
 * `bypassCSP` is deliberately FALSE — the opposite of `bookforge-page`. quire's
 * whole point is that the page's CSP applies to the book, so the scheme must not
 * be allowed to step around it.
 */
export function registerQuireScheme(): void {
  if (schemeRegistered) return;
  // Required lazily so this module can be imported by tests with no Electron app.
  const { protocol } = require('electron');
  protocol.registerSchemesAsPrivileged([
    {
      scheme: QUIRE_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: false,
        corsEnabled: false,
        allowServiceWorkers: false,
        stream: false,
        bypassCSP: false,
      },
    },
  ]);
  schemeRegistered = true;
}

export function assertQuireSchemeRegistered(): void {
  if (!schemeRegistered) {
    quireFail(
      'SCHEME_NOT_REGISTERED',
      'registerQuireScheme() was never called. It must run at module scope in the main '
      + 'process, before app.whenReady(), the same way electron/main.ts registers '
      + 'bookforge-page. quire will not fall back to a file:// or unprivileged scheme.',
    );
  }
}

/** What a request resolved to: an archive entry, or a refusal with a reason. */
export type QuireResolution =
  | { ok: true; entry: string }
  | { ok: false; status: number; reason: string };

const TRAVERSAL_REASONS: Array<[RegExp, string]> = [
  [/\\/, 'the path contains a backslash'],
  [/\0/, 'the path contains a NUL byte'],
  [/^[a-zA-Z]:/, 'the path looks like a Windows drive-absolute path'],
];

/**
 * Pure request resolution — no Electron, no filesystem. Exported so the refusal
 * rules can be tested directly rather than inferred from behaviour.
 *
 * @param url        the full request URL
 * @param sessionId  the session this handler belongs to; the URL host must match
 * @param hasEntry   membership test against the archive's central directory
 */
export function resolveQuireRequest(
  url: string,
  sessionId: string,
  hasEntry: (name: string) => boolean,
): QuireResolution {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, status: 400, reason: `"${url}" is not a URL` };
  }
  if (parsed.protocol !== `${QUIRE_SCHEME}:`) {
    return { ok: false, status: 400, reason: `scheme "${parsed.protocol}" is not quire:` };
  }
  if (parsed.host !== sessionId) {
    return {
      ok: false,
      status: 403,
      reason: `host "${parsed.host}" is not this document's session "${sessionId}"`,
    };
  }

  // The path is taken from the RAW url, not from `parsed.pathname`.
  //
  // `quire` is a STANDARD scheme, which means the WHATWG parser resolves `.` and
  // `..` before anything here runs: `new URL('quire://s/a/../b').pathname` is
  // already `/b`. Reading the parsed pathname would therefore make the checks
  // below unreachable — every traversal would arrive pre-collapsed and be
  // served, and the code that "refuses traversal" would be decoration. Chromium
  // clamps at the root so this is not itself an escape, but quire does not want
  // to serve a request whose meaning was silently rewritten between the asking
  // and the answering. It wants to refuse it and say so.
  const afterScheme = url.slice(`${QUIRE_SCHEME}://`.length);
  const firstSlash = afterScheme.indexOf('/');
  if (firstSlash === -1) {
    return { ok: false, status: 400, reason: 'the URL names no path within the archive' };
  }
  let raw = afterScheme.slice(firstSlash);
  // A query or fragment is deliberately not honoured — quire serves archive
  // entries, and an entry name is the whole address.
  const cut = Math.min(
    ...['?', '#'].map((c) => { const i = raw.indexOf(c); return i === -1 ? raw.length : i; }));
  raw = raw.slice(0, cut);
  try {
    raw = decodeURIComponent(raw);
  } catch {
    return { ok: false, status: 400, reason: 'the path is not valid percent-encoding' };
  }

  for (const [re, reason] of TRAVERSAL_REASONS) {
    if (re.test(raw)) return { ok: false, status: 403, reason };
  }

  if (!raw.startsWith('/')) {
    return { ok: false, status: 400, reason: 'the path is not absolute within the archive' };
  }
  const segments = raw.slice(1).split('/');
  for (const seg of segments) {
    if (seg === '..') {
      return { ok: false, status: 403, reason: 'the path contains a ".." segment' };
    }
    if (seg === '.') {
      return { ok: false, status: 403, reason: 'the path contains a "." segment' };
    }
    if (seg === '') {
      return { ok: false, status: 403, reason: 'the path contains an empty segment' };
    }
  }

  const entry = segments.join('/');
  if (!hasEntry(entry)) {
    return { ok: false, status: 404, reason: `the archive has no entry "${entry}"` };
  }
  return { ok: true, entry };
}

const CONTENT_TYPES: Record<string, string> = {
  xhtml: 'application/xhtml+xml',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
};

export function contentTypeFor(entry: string): string {
  const dot = entry.lastIndexOf('.');
  if (dot === -1) {
    quireFail('UNKNOWN_CONTENT_TYPE', `archive entry "${entry}" has no extension, so its type cannot be stated`);
  }
  const ext = entry.slice(dot + 1).toLowerCase();
  const type = CONTENT_TYPES[ext];
  if (!type) {
    quireFail(
      'UNKNOWN_CONTENT_TYPE',
      `archive entry "${entry}" has extension ".${ext}", which quire does not serve. `
      + 'Serving it as octet-stream would let the renderer sniff it; refusing is the safe answer.',
    );
  }
  return type;
}

/**
 * The Content-Security-Policy every quire document is served under, as a header.
 *
 * `frame-ancestors` is meaningful in a header and IGNORED in a `<meta>`, so
 * {@link quireCspMeta} drops it rather than have every document in the book log
 * a warning about a directive that was never going to apply there.
 */
export function quireCsp(): string {
  return [
    "default-src 'none'",
    `img-src ${QUIRE_SCHEME}: data:`,
    `style-src ${QUIRE_SCHEME}: 'unsafe-inline'`,
    `font-src ${QUIRE_SCHEME}: data:`,
    "script-src 'none'",
    "connect-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** The same policy, minus the one directive a `<meta>` cannot carry. */
export function quireCspMeta(): string {
  return quireCsp()
    .split('; ')
    .filter((directive) => !directive.startsWith('frame-ancestors'))
    .join('; ');
}

export interface AttachedProtocol {
  /** Every request the session refused, newest last. Read by the tests and the CLI. */
  readonly refusals: Array<{ url: string; reason: string }>;
  detach(): void;
}

/**
 * Wire `quire://` onto one Electron session, along with the two blanket denials.
 *
 * @param overrides entry name → bytes served instead of the archive's own. The
 *   pagination shell for each spine document lives here: the document the
 *   renderer loads is the book's markup with scripts removed and the layout CSS
 *   appended, and it is served at the document's OWN address so that every
 *   relative URL inside it resolves exactly as the book wrote it.
 */
export function attachQuireProtocol(
  ses: Electron.Session,
  sessionId: string,
  archive: QuireArchive,
  overrides: Map<string, { body: Buffer; contentType: string }>,
): AttachedProtocol {
  const refusals: Array<{ url: string; reason: string }> = [];

  ses.protocol.handle(QUIRE_SCHEME, async (request) => {
    const resolution = resolveQuireRequest(request.url, sessionId, (name) =>
      overrides.has(name) || archive.hasEntry(name));
    if (!resolution.ok) {
      refusals.push({ url: request.url, reason: resolution.reason });
      return new Response(`quire refused this request: ${resolution.reason}`, {
        status: resolution.status,
        headers: { 'content-type': 'text/plain', 'content-security-policy': quireCsp() },
      });
    }

    const override = overrides.get(resolution.entry);
    const body = override ? override.body : await archive.readEntry(resolution.entry);
    const contentType = override ? override.contentType : contentTypeFor(resolution.entry);
    // Copied into an array buffer of its own rather than handed over as a
    // Buffer: a Buffer is a window onto a larger pooled allocation, and handing
    // the pool to a Response would expose whatever else is in it.
    const bytes = new Uint8Array(body);
    return new Response(bytes, {
      status: 200,
      headers: {
        'content-type': contentType,
        // Belt and braces with the <meta> in the shell: a header CSP cannot be
        // removed by editing the markup, and a <meta> CSP survives a handler
        // that forgot the header. Both say the same thing.
        'content-security-policy': quireCsp(),
        'cache-control': 'no-store',
      },
    });
  });

  // Nothing but quire: leaves this session. The CSP already blocks remote loads;
  // this is the second, independent mechanism, and it is the one that would
  // still hold if a book found a CSP hole.
  ses.webRequest.onBeforeRequest((details, callback) => {
    if (details.url.startsWith(`${QUIRE_SCHEME}://`)) {
      callback({ cancel: false });
      return;
    }
    refusals.push({ url: details.url, reason: 'the session allows no scheme but quire:' });
    callback({ cancel: true });
  });

  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    refusals.push({ url: `permission:${permission}`, reason: 'quire grants no permissions' });
    callback(false);
  });
  ses.setPermissionCheckHandler(() => false);

  return {
    refusals,
    detach(): void {
      ses.protocol.unhandle(QUIRE_SCHEME);
      ses.webRequest.onBeforeRequest(null);
    },
  };
}
