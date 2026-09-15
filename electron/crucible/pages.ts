/**
 * READING PAGES ON SOMEBODY ELSE'S CARD — the `pages` act.
 *
 * ── THE DOOR THAT MOVED, AND WHY IT IS NOT A JOB ───────────────────────────
 *
 * `crucible/docs/PHASE3-VLM.md` §1 settles this, and it settles it against
 * DESIGN.md's own earlier sketch: **there is no `vlm-pages` job type, and there
 * is no `crucible/jobs/pages/` directory.** What a page reader does is send an
 * ORDINARY chat completion whose first content part is a data-URI PNG, one page
 * per request, twelve in flight, `temperature: 0`. So `pages` is a capability
 * CLASS whose `job_type` is `llm` (`crucible/capability.py`, `name="pages"`,
 * `job_type="llm"`), served by the `dots-ocr` manifest through the same OpenAI
 * proxy the four text acts use.
 *
 * That decides the shape of this file completely. BookForge does not submit
 * page images anywhere — foundry's own engine does the sending, from a binary
 * BookForge spawns — so this is NOT built on `runCrucibleJob`. It is built the
 * way `text-acts.ts` builds the four text acts: **the ENDPOINT becomes a
 * Crucible.** The engine is handed a base URL and a header map, and the word
 * Crucible never appears in foundry's source.
 *
 * What dies with it is the SPAWN half of `electron/vlm-page-server.ts` — 484
 * lines of `wsl.exe`, VRAM arithmetic and guest `pkill` that exist only because
 * vLLM has no Windows build. PHASE3-VLM.md §7 names it, `wslVlmRefusal`,
 * `useWsl2ForVlm`, `wslVlmCondaEnv`, `wslVlmModel` and the `wsl-server` arm of
 * `resolveVlmRoute` as what this deletes once it is live. It is NOT deleted
 * here: the legacy switch still routes to it, and it goes in a commit Owen
 * approves after his in-app pass (docs/CRUCIBLE_ROLLOUT_PLAN.md tier 3).
 *
 * ── THE BASE IS `<url>/openai/v1`, AND IT IS NOT `crucibleChatBase()` ───────
 *
 * The single most load-bearing line in this file, and the one a reader will
 * want to "unify" with the text acts' base. It cannot be unified, because
 * foundry composes the two routes' URLs by DIFFERENT rules — read out of its
 * source, not remembered:
 *
 *   · the text route (`src/translate/vllm.ts:138`, `normaliseVllmEndpoint`)
 *     appends `/v1` to any base that does not already end in `/vN`. So it is
 *     handed `<url>/openai` and asks for `<url>/openai/v1/chat/completions`.
 *     That is what {@link crucibleChatBase} is for, and it is right there.
 *
 *   · **the page route (`src/vlm/endpoint.ts:142`) does NOT normalise.** It is
 *     `` `${opts.endpoint.replace(/\/+$/, '')}/chat/completions` `` — verbatim,
 *     no version segment added. Handed `<url>/openai` it would ask for
 *     `<url>/openai/chat/completions`, which is a 404 against a door that
 *     exists.
 *
 * So the page reader's base carries the version itself: `<url>/openai/v1`. The
 * two spellings are not a discrepancy to tidy away — they are two clients with
 * two rules, and this module states the rule it is written against.
 *
 * (Confirming the other half of the same base: the model listing DOES go
 * through `normaliseVllmEndpoint` — `confirmServedModel` → `servedModels` — and
 * `/openai/v1` already ends in a version, so it stays put and asks
 * `<url>/openai/v1/models`. One base, both paths correct.
 * `tools/test-crucible-pages.js` pins both compositions.)
 *
 * ── WHAT THIS REFUSES, BY NAME, AND NEVER FALLS BACK FROM ──────────────────
 *
 * **`dots-ocr` has no `mlx-darwin` block.** Deliberately, and the manifest says
 * why: `mlx-community/dots.ocr-4bit` exists and Foundry's in-process `mlx-local`
 * route serves it on the Mac today, so a Crucible block with an unmeasured
 * estimate would compete with a route that works. A Mac venue therefore has the
 * model in its catalog with `backendSupported: false` and a reason naming the
 * missing block — and that refusal must read as *"page reading is the PC's"*
 * rather than as a crash. {@link CRUCIBLE_PAGES_NO_BACKEND} is that sentence,
 * and it names the two ways forward: route the run to a PC Crucible, or turn on
 * the legacy switch and let the Mac read its own pages with MLX.
 *
 * **Residency is the operator's.** The act's model must already be resident;
 * nothing here loads one, because a load EVICTS whatever is on that card and on
 * a shared server that is somebody else's book. Same discipline as
 * `text-venue.ts` and `ai-bridge.ts`, and there is no `loadFirst` here at all —
 * no BookForge gesture means "load the page reader", so the door that would use
 * one does not exist yet.
 *
 * **An image-capable model is CHOSEN from `modalities`, not known by name.**
 * PHASE3-VLM.md §2 made `modalities` a required key in every manifest precisely
 * so a client does not have to know one by name. {@link CRUCIBLE_PAGES_MODEL}
 * is the id this build asks for; that it can actually take a picture is read
 * off the server's own row, and a server whose `dots-ocr` says text-only is
 * refused with the image-capable ids it DOES offer.
 *
 * **The installed foundry must honour the header map.** See
 * {@link FOUNDRY_VERSION_FOR_CRUCIBLE_PAGES} — the pinned release does not, and
 * a run that dropped the credential would reach the server unauthenticated.
 *
 * There is no fallback anywhere in here. A refused page read is a refused page
 * read; quietly starting the WSL vLLM instead would take a card somebody else
 * is using and spend ninety minutes producing a book nobody asked that machine
 * for.
 *
 * ── THE CREDENTIAL ─────────────────────────────────────────────────────────
 *
 * Identical rules to the text acts, because it is the same variable and the
 * same contract (crucible `docs/PHASE7-LANES.md` §8.0): never a flag, never
 * logged except through {@link maskEndpointHeaders}, and carried as an OVERLAY
 * on ONE spawn rather than written into `process.env`. `runFoundry` takes
 * `opts.env` and strips the variable from every child that did not ask for one,
 * so the reach question `text-venue.ts` has to ask its callers has exactly one
 * answer here: the page reader is always BookForge's own spawn.
 */

import type { ModelInfo } from '@crucible/client';
import type { RankedServerRow, RoutingView } from '../../shared/crucible/settings-wire';
import { processVenueHost, type VenueHost } from './generation-venue';
import type { CruciblePingResult } from './probe';
import { crucibleClientFor, getServer, CRUCIBLE_CLIENT_NAME, type ResolvedServer } from './servers';
import { venueForRunStep, type RunVenue, type StepVenue } from './step-venue';
import {
  CRUCIBLE_ACT_HEADER,
  CRUCIBLE_API_VERSION,
  crucibleChatBase,
  FOUNDRY_ENDPOINT_HEADERS_VAR,
  maskEndpointHeaders,
} from './text-acts';

// ─────────────────────────────────────────────────────────────────────────────
// The act, the model and the base
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The act, spelled exactly as crucible's `capability.py` names the class.
 *
 * NOT one of `CRUCIBLE_TEXT_ACTS` — that constant is the four text acts and its
 * own comment says `pages` is the VLM door and is not among them. Crucible
 * refuses an act name it does not know (`400 unknown_act`), so a typo here is a
 * refused run rather than a bench confidently wrong about what is on the card.
 * `tools/test-crucible-pages.js` checks this spelling against `capability.py`
 * itself rather than against this repo's memory of it.
 */
export const CRUCIBLE_PAGES_ACT = 'pages';

/**
 * The Crucible model id a page read asks for.
 *
 * PHASE3-VLM.md §5: *"the client sets `--vlm-endpoint-model dots-ocr`. That is
 * one settings value and no code."* Crucible's ids are its own — no slashes,
 * deliberately — and the proxy refuses a chat whose `model` is not the resident
 * id, by name, with no rewriting. So the HuggingFace path both apps used to
 * send (`rednote-hilab/dots.ocr`, now `dots-studio/dots.ocr`) is not what
 * crosses; Crucible's id is.
 *
 * RULING OWED, RESTATED 2026-09-14 because half of it was answered. It used to
 * read "this is a constant here and a per-act ROW IN SETTINGS for the four text
 * acts". There is no such row any more: `<userData>/crucible-models.json` and
 * `electron/crucible/text-models.ts` are deleted, and `GET /v1/capability` owns
 * the per-class model — `crucible install` probes the card and selects, so the
 * mapping is a fact about the server. `pages` IS one of those capability
 * classes, so the question is now sharper and smaller: does this constant give
 * way to the server's `capability` row for `pages`, exactly as the four text
 * acts just did? It stays a constant here because `crucible/jobs/pages` has no
 * job type of its own (`pages` rides the `llm` env), and because the id is
 * checked against the server's catalog either way — so a wrong one is a refusal
 * and never a silently different book.
 */
export const CRUCIBLE_PAGES_MODEL = 'dots-ocr';

/** What a model row must list for a page to be sendable to it (PHASE3-VLM.md §2). */
export const CRUCIBLE_IMAGE_MODALITY = 'image';

/**
 * The base `foundry vlm-convert --vlm-endpoint` is handed for one server.
 *
 * `<url>/openai/v1` — the version segment is HERE and not left to the client,
 * because the page route does not add one. See this module's header for the two
 * foundry composition rules and where each is written.
 */
export function cruciblePagesEndpoint(url: string): string {
  return `${crucibleChatBase(url)}/v1`;
}

/**
 * The header map for a page read: the bearer, the API version, and the act
 * named truthfully.
 *
 * Its own function rather than `text-acts.ts`'s {@link maskEndpointHeaders}
 * sibling `endpointHeaderMap`, which is typed to `CrucibleTextAct` — the four.
 * Widening that type so `pages` could pass through it would let a page read
 * present itself as a text act at the type level, which is the lie the four-act
 * split exists to prevent. Same three headers, one different act.
 */
export function pagesEndpointHeaderMap(token: string): Record<string, string> {
  if (token === '') {
    // A Crucible has no anonymous mode, so an empty token is not a quieter
    // request — it is a 401 with nothing saying why.
    throw new CruciblePagesError(
      'crucible_empty_token',
      'the page reader\'s header map would carry an empty bearer token. Every Crucible route but '
      + '/v1/ping needs one; the local server\'s comes from its own config.toml and a remote\'s '
      + 'from the registry.',
    );
  }
  return {
    Authorization: `Bearer ${token}`,
    'X-Crucible-Api': CRUCIBLE_API_VERSION,
    [CRUCIBLE_ACT_HEADER]: CRUCIBLE_PAGES_ACT,
  };
}

/** The env OVERLAY for ONE `runFoundry` spawn — never a write to `process.env`. */
export function pagesEndpointHeadersEnv(token: string): Record<string, string> {
  return { [FOUNDRY_ENDPOINT_HEADERS_VAR]: JSON.stringify(pagesEndpointHeaderMap(token)) };
}

// ─────────────────────────────────────────────────────────────────────────────
// The foundry the pages go through
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE RELEASE WHOSE PAGE READER HONOURS `$FOUNDRY_ENDPOINT_HEADERS`.
 *
 * The credential reaches the server only if the binary that sends the pages
 * reads the map. `src/vlm/read.ts` calls `resolveEndpointHeaders()` and passes
 * the result into both `confirmModel` and every page request — and that line
 * arrived at foundry `2d5d411`, which is AFTER the v1.2.0 release tag
 * (`eb69b7a`) that `foundry-cli-components.ts` currently installs. Measured,
 * not assumed: `git show eb69b7a:src/vlm/read.ts | grep -c resolveEndpointHeaders`
 * answers 0.
 *
 * **THE VERSION STRING CANNOT TELL THE TWO APART, and this floor is therefore
 * deliberately conservative.** Both `eb69b7a` (no headers) and `2d5d411` (with
 * them) report `"version": "1.2.0"`, because the release number is bumped at
 * release time and the feature landed mid-cycle. There is nothing on the
 * binary's surface that answers "do you read that variable" — no flag, no
 * `backend --json` field, only help prose that is not machine-consumed. So the
 * floor is set at the NEXT release rather than at 1.2.0, and a dev binary built
 * from a commit that DOES have the feature but still says 1.2.0 is refused.
 *
 * Refusing a binary that would work costs a named refusal somebody can act on.
 * Admitting one that would not costs a whole book's worth of page requests
 * arriving unauthenticated — or, on a server that happens not to require a
 * token, SUCCEEDING while silently not doing the thing it was configured to do,
 * which is the failure foundry's own `endpoint-headers.ts` header calls out as
 * "far worse". Wrong in the safe direction, on purpose.
 *
 * THIS IS NOW THE ONLY CONSTANT OF ITS KIND, and the other one's fate says why
 * it is still here. `FOUNDRY_VERSION_FOR_CRUCIBLE_TEXT` sat beside it waiting
 * on a per-run env argument in the vendored app's `runEngine`; that argument
 * landed (foundry `f300fc6`) and the guard went on refusing for ten hours,
 * because a version number cannot see a line of code. It was DELETED on
 * 2026-09-14 and replaced by a keeper that reads the vendored subtree
 * (`tools/test-foundry-hosted-crucible-seam.js`). This constant is not that
 * shape: it waits on a CLI BINARY that already has what it needs and has not
 * been RELEASED, which is exactly the thing a version number does answer — a
 * binary is asked `--version` and cannot be read. The
 * number itself is a guess at the next release: 1.3.0 was prepared and then
 * VOIDED by Owen's 2026-09-13 22:40 reframe, so `1.4.0` is the first spelling
 * that is certainly not the void one. If the next release is numbered
 * differently, this constant moves with it.
 */
export const FOUNDRY_VERSION_FOR_CRUCIBLE_PAGES = '1.4.0';

/** The refusal for a foundry that would drop the credential on the floor. */
export function foundryTooOldForCruciblePages(installed: string, server: string): string {
  return (
    `Reading pages on the Crucible server "${server}" needs a foundry whose page reader sends `
    + `$${FOUNDRY_ENDPOINT_HEADERS_VAR}, and the installed one is ${installed}. `
    + 'The page route reads that map at foundry `src/vlm/read.ts` (`resolveEndpointHeaders`), which '
    + `landed after the v1.2.0 release this app installs — and both builds report "1.2.0", so the `
    + `floor is the next release (FOUNDRY_VERSION_FOR_CRUCIBLE_PAGES, currently `
    + `${FOUNDRY_VERSION_FOR_CRUCIBLE_PAGES}). Nothing ran, and no page was sent without its `
    + 'credential. Until that release is cut, type an endpoint under Settings → AI → Reading '
    + 'pages: a typed endpoint is a deliberate choice of GPU and is asked before this decision.'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Refusals
// ─────────────────────────────────────────────────────────────────────────────

export type CruciblePagesErrorCode =
  /** The header map would carry an empty bearer token. */
  | 'crucible_empty_token'
  /** The installed foundry would not send the map. */
  | 'foundry_too_old_for_crucible_pages'
  /** The chosen server's catalog has no manifest with this id at all. */
  | 'crucible_pages_model_not_offered'
  /**
   * It HAS the manifest and this host's backend cannot serve it — the Mac, where
   * `dots-ocr` has no `mlx-darwin` block. The one refusal that must read as
   * "page reading is the PC's".
   */
  | 'crucible_pages_no_backend'
  /** The manifest is served here and does not take pictures. */
  | 'crucible_pages_model_not_image_capable'
  /** Nothing is serving it. The operator's job, never a page read's. */
  | 'crucible_pages_model_not_resident'
  /**
   * 409 `model_leased`: another client has said it is mid-run on that server's
   * resident model, so nothing may move it off the card — including this read's
   * own lease. A WAIT with the holder's name, act and since, never a retry loop.
   */
  | 'crucible_pages_model_leased';

export class CruciblePagesError extends Error {
  readonly code: CruciblePagesErrorCode;

  /**
   * The code is PREFIXED onto the message, not merely carried beside it — the
   * rule `CrucibleTextActError` states: a CLI and a queue row show `err.message`
   * and nothing else, so "refused by name" is only true where the name is in
   * the sentence.
   */
  constructor(code: CruciblePagesErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'CruciblePagesError';
    this.code = code;
  }
}

/**
 * The sentence for a Mac venue, kept as a constant because it is the one
 * refusal this door exists to get RIGHT rather than merely to make.
 *
 * A person reading it must come away with "page reading happens on the PC", not
 * with "something broke". So it says what is true (`dots-ocr` is a cuda-linux
 * manifest and the Mac's own MLX reader is untouched), and it names both ways
 * forward before it stops.
 */
export const CRUCIBLE_PAGES_NO_BACKEND = 'page reading is the PC\'s';

// ─────────────────────────────────────────────────────────────────────────────
// The host: everything this decision reads from the world
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `VenueHost`'s three doors plus the two a page read needs, so a keeper drives
 * every branch with no registry, no record on disk and no network — the shape
 * `generation-venue.ts` and `text-venue.ts` both use, for the same reason.
 */
export interface PagesVenueHost extends VenueHost {
  /** One server WITH its token: `local` from its config, a remote from the registry. */
  server(name: string): ResolvedServer;
  /** `GET /v1/models` on that server. */
  models(name: string): Promise<ModelInfo[]>;
}

/** The real one: the app's routing record, the real registry and real HTTP. */
export function processPagesVenueHost(): PagesVenueHost {
  const venue = processVenueHost();
  return {
    view: (): RoutingView => venue.view(),
    enabled: (): RankedServerRow[] => venue.enabled(),
    ping: (name: string): Promise<CruciblePingResult> => venue.ping(name),
    server: getServer,
    async models(name: string): Promise<ModelInfo[]> {
      return crucibleClientFor(name, CRUCIBLE_CLIENT_NAME).models();
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Where the pages are read
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where this conversion's pages are read, from the ONE decision every travelling
 * step makes.
 *
 * THAT DAY CAME (2026-09-14, item A3): `vlm-convert` declares `machines()`, so
 * a conversion queued in a chain that then narrates IS a step of a run, and it
 * follows the run's machine instead of deciding again. `runVenue` is that
 * answer when the caller has one — the row's `waitForResolved`, through
 * `runVenueOfRow` — and with none, `venueForRunStep` asks
 * `decideWhereGenerationRuns`, which is the caller's name → the routing record,
 * in that order. A standalone conversion from the library has no run and decides
 * for itself.
 *
 * A `callerNamed` that DISAGREES with the run's venue is refused by name
 * (`run_venue_disagrees`), not ranked — the rule belongs to `venueForRunStep`
 * and is not restated here.
 *
 * THE LOCAL PAGE READERS ARE GONE — the MLX reader on Apple silicon and the WSL
 * vLLM server on Windows went with the legacy spawn layer
 * (docs/LEGACY-REMOVAL.md), so this answers with a Crucible server or refuses.
 * What did NOT go is the TYPED ENDPOINT in Settings → AI → Reading pages: it is
 * a deliberate choice of GPU, it is asked BEFORE this decision
 * (`electron/vlm-convert.ts`), and it still wins.
 */
export async function decideWherePagesRun(
  host: PagesVenueHost,
  callerNamed?: { server: string },
  runVenue?: RunVenue,
): Promise<StepVenue> {
  return venueForRunStep({
    ...(callerNamed === undefined ? {} : { callerNamed }),
    ...(runVenue === undefined ? {} : { runVenue, runVenueSource: 'the queue row' }),
    host,
  });
}

/** Everything one page-reading run needs against one Crucible server. */
export interface CruciblePageReader {
  /** The server this resolved to, by name. Never a URL. */
  server: string;
  /** `--vlm-endpoint`: `<url>/openai/v1`. See the header for the version segment. */
  endpoint: string;
  /** `--vlm-endpoint-model`: the Crucible id, proved resident and image-capable. */
  model: string;
  /** The act, named truthfully. Goes in `X-Crucible-Act`. */
  act: typeof CRUCIBLE_PAGES_ACT;
  /** The env OVERLAY for the spawn. One key: `FOUNDRY_ENDPOINT_HEADERS`. */
  env: Record<string, string>;
  /** The header map with the credential masked — the ONLY form a log may carry. */
  maskedHeaders: string;
  /** What the server's row said it is, for the run's record. `null` on a host with no block. */
  fingerprint: string | null;
}

/**
 * Compose what a Crucible page read needs, or refuse by name before any spawn.
 *
 * In the order the refusals matter, cheapest and most final first: is the model
 * in this server's catalog at all, can this HOST serve it, does it take
 * pictures, and is it up. Every one of them is a question a 90-minute run would
 * otherwise answer on page one.
 */
export async function resolveCruciblePageReader(
  server: string,
  host: PagesVenueHost,
  model: string = CRUCIBLE_PAGES_MODEL,
): Promise<CruciblePageReader> {
  const rows = await host.models(server);
  const row = rows.find((m) => m.id === model);

  if (row === undefined) {
    const known = rows.map((m) => m.id).join(', ');
    throw new CruciblePagesError(
      'crucible_pages_model_not_offered',
      `crucible "${server}" has no model "${model}", which is what this build asks for to read `
      + `pages (${rows.length === 0 ? 'it advertises none' : `known: ${known}`}). A Crucible id is `
      + 'its own — no HuggingFace path is ever sent — so this is a server running a build with no '
      + 'page-reader manifest, not a name that needs translating.',
    );
  }

  /*
   * THE MAC. `dots-ocr` is in every build's catalog and has no
   * `[backends.mlx-darwin]` block, so on an Apple Silicon host the row comes
   * back with `backendSupported: false` and a `reason` naming the missing
   * block. That is not a fault and must not read as one — the Mac has a page
   * reader, it is Foundry's in-process MLX route, and PHASE3-VLM.md §7 says it
   * stays exactly where it is.
   */
  if (!row.backendSupported) {
    throw new CruciblePagesError(
      'crucible_pages_no_backend',
      `${CRUCIBLE_PAGES_NO_BACKEND}: crucible "${server}" cannot serve "${model}" on its own `
      + `backend — ${row.reason ?? 'its manifest has no block for this host'}. The page reader is a `
      + 'cuda-linux manifest on purpose (crucible models/dots-ocr.toml): Apple silicon already has '
      + 'a page reader in MLX, and a Crucible block with an unmeasured estimate would compete with '
      + 'a route that works. Send this conversion to a PC Crucible — rank one first in '
      + 'Settings → Crucible Servers — or type an endpoint under Settings → AI → Reading pages, '
      + 'which is a deliberate choice of GPU and wins over Crucible routing. '
      + 'Nothing ran and no page was read.',
    );
  }

  /*
   * IMAGE-CAPABLE, read off the row rather than known by name. PHASE3-VLM.md §2
   * made `modalities` a required key in every manifest for exactly this: a
   * client picks a model that takes pictures from the list instead of carrying
   * a hard-coded one that might quietly have become text-only.
   */
  if (!row.modalities.includes(CRUCIBLE_IMAGE_MODALITY)) {
    const capable = rows
      .filter((m) => m.modalities.includes(CRUCIBLE_IMAGE_MODALITY))
      .map((m) => m.id);
    throw new CruciblePagesError(
      'crucible_pages_model_not_image_capable',
      `crucible "${server}" serves "${model}" as ${row.modalities.join('+') || 'nothing'}, not as a `
      + 'model that takes pictures, so a page sent to it would be refused at the content parts. '
      + `${capable.length > 0
        ? `It does offer: ${capable.join(', ')}.`
        : 'It offers no image-capable model at all.'}`,
    );
  }

  if (!row.resident) {
    const resident = rows.filter((m) => m.resident).map((m) => m.id);
    throw new CruciblePagesError(
      'crucible_pages_model_not_resident',
      `"${model}" is not resident on crucible "${server}", so the pages cannot be read there `
      + `(${resident.length > 0 ? `resident: ${resident.join(', ')}` : 'nothing is resident'}`
      + `${row.loadable ? '' : `; and it is not loadable there — ${row.reason ?? 'no reason given'}`}). `
      + 'Loading a model evicts whatever is on that card, so a conversion never does it: load it '
      + `yourself — bookforge-tts --crucible-load --server ${server} --model ${model}, or the Load `
      + 'button in Settings → Crucible Servers.',
    );
  }

  const entry = host.server(server);
  return {
    server,
    endpoint: cruciblePagesEndpoint(entry.url),
    model,
    act: CRUCIBLE_PAGES_ACT,
    env: pagesEndpointHeadersEnv(entry.token),
    maskedHeaders: maskEndpointHeaders(pagesEndpointHeaderMap(entry.token)),
    fingerprint: row.fingerprint,
  };
}

/**
 * ── A PAGE READ IS A RUN, SO IT TAKES A LEASE ──────────────────────────────
 *
 * Owen, 2026-09-14: *"Models should always be unloaded when we're done with
 * them. Every time."* A Crucible unloads the resident model the moment no job,
 * no lease, no streaming session and no chat hold it (crucible
 * `docs/PHASE7-LANES.md` §5.3).
 *
 * A page read holds none of those. §1 of this file's header is the reason: there
 * is no `vlm-pages` JOB — every page crosses as an ordinary chat completion with
 * a data-URI PNG in it, twelve in flight, and a chat takes no lane and holds no
 * claim. A 317-page PDF is 317 requests against one resident `dots-ocr`, and
 * between any two of them that server is idle by every measure it publishes.
 * Without this, the model would be unloaded and reloaded around the whole book.
 *
 * ONE LEASE FOR THE WHOLE CONVERSION, taken around the spawn — that spawn is
 * exactly the span in which this app intends more requests. The act is
 * {@link CRUCIBLE_PAGES_ACT}, the same word the engine sends in
 * `X-Crucible-Act`: one name from one field, so a bench beside the card cannot
 * be told one thing while the requests say another.
 *
 * `409 model_leased` on the take is a WAIT rendered with the holder's line, and
 * nothing here waits it out — that decision belongs to whoever pressed the
 * button, never to a sleep loop in a library (ARCHITECTURE.md R5).
 */
export async function withCruciblePagesLease<T>(
  reader: CruciblePageReader,
  run: () => Promise<T>,
): Promise<T> {
  const { withCrucibleLease, CrucibleLeased } = await import('./lease.js');
  // Only the TAKE is translated: once `run` has begun, what it throws is the
  // conversion's own failure and keeps its stack.
  let started = false;
  try {
    return await withCrucibleLease(
      { server: reader.server, kind: 'model', id: reader.model, act: reader.act },
      async () => {
        started = true;
        return run();
      },
    );
  } catch (err) {
    if (started) throw err;
    if (err instanceof CrucibleLeased) {
      throw new CruciblePagesError(
        'crucible_pages_model_leased',
        `crucible "${reader.server}"'s resident model is leased by another run, so the pages were `
        + `not read there: ${err.leasedLine} (until at least ${err.expiresAt}). A lease is that `
        + 'client saying it intends more work on this model; nothing here waits it out, loads a '
        + 'model, or quietly reads the pages on this machine instead. Try again when that run is '
        + 'done, or pick another server.',
      );
    }
    throw err;
  }
}
