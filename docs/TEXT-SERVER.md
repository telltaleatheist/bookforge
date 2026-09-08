# The text server — BookForge's vLLM behind Foundry's language passes

**Owen, 2026-09-08:** *"lets build in vllm batching. ollama batching doesnt work. its an
unfinished feature ollama tried to implement but isnt accessible on the mac or pc. cuda
graphs/vllm would probably be the best for all three features."* And an hour later:
*"build that piece. the arbiter that starts/stops it."*

Foundry's four language acts — `clean-text`, `translate`, `translate --rewrite` (simplify)
and `analyze` — speak either Ollama or an OpenAI-compatible vLLM, chosen by
`--server ollama|vllm`. **Foundry never starts, stops or warms that server**
(`foundry-app/VENDORED.md`, last paragraph; the engine checkout's `docs/VLLM.md` §5:
"BookForge's arbiter owns that server's life"). This document is that owner:
`electron/text-server.ts`, the launcher `electron/scripts/vllm/serve_text_vllm.sh`, and the
staging script `electron/scripts/vllm/text_model_download.py`.

## Why it exists — measured, not assumed

Ollama 0.33.3 refuses to decode the qwen35 architecture in parallel on its llama.cpp
backend (`sched.go:509`), so `OLLAMA_NUM_PARALLEL=4` and Foundry's four-in-flight pool
bought nothing: every text pass ran **one request at a time** on a 24 GB card.

| | Ollama | this server |
|---|---|---|
| Pokemon book, clean-text | 110 blocks/min | **458 blocks/min** |
| requests decoding | 1 | 7 (3 more queued for KV capacity, out of Foundry's 12) |
| weights resident | ~19 GB | 18.26 GiB, cache pool 22,420 tokens at util 0.90 |

The costs, on the same machine and the same day: **~110 s to start** (15 s model load, 94 s
init, "Application startup complete" at ~110 s) and therefore **~95 s to swap** one profile
for the other.

## The profiles

`TEXT_MODEL_PROFILES` in `electron/text-server.ts`. One model, served one way; nothing a
caller decides.

| id | served name | act | weights | revision |
|---|---|---|---|---|
| `qwen35-9b-bf16` | `Qwen3.5-9B-bf16` | **clean** | `~/models/Qwen3.5-9B`, bf16, ~19 GB | `Qwen/Qwen3.5-9B` @ `c2022362` |
| `qwen38-27b-awq-int4` | `Qwen3.8-27B-AWQ-INT4` | **translate, simplify, analysis** | `~/models/Qwen3.8-27B-AWQ-INT4`, compressed-tensors INT4, 20 GB / 5 shards | `cyankiwi/Qwen3.8-27B-AWQ-INT4` @ `63768c10` |

Both live on the guest's **ext4**, never under `/mnt` — the 9p mount is slow and the server
never reads the Windows side (`higgs-hf-install`'s rule).

Three properties of a served name are load-bearing, and `assertProfileTable()` holds all
three at import:

1. **It is the record.** Foundry resolves the model by asking `/v1/models` and writes that
   id into the bank key, the records key and the narration stamp. It carries no separate
   precision field — a server cannot report its dtype — so the name must SAY the precision,
   or two books cleaned at two precisions are byte-indistinguishable in their records.
2. **It must still look like a Qwen 3.** Foundry's `takesThinkField`
   (`src/translate/ollama.ts`) is `/^qwen3(\.|:|-|$)/i` over the last path segment, and it
   is what sends `chat_template_kwargs.enable_thinking=false`. A name that fails it leaves
   thinking ON, and the model reasons before *every block of the book*.
3. **The revision is pinned to a commit sha, never `main`.** `main` moves, and a repo that
   moved under a book is a records key that means two different models on two different days.

### Which model a job runs on, and how that is guaranteed

`profileForKind(kind)` maps `clean` → the 9B and `translate` / `simplify` / `analysis` → the
27B. (`analysis` does not cross the host queue yet — `FoundryJobKind` is
`epub|txt|pdf|read|translate|simplify|clean` — so Foundry still runs it in its own queue.
It is declared here so the day it crosses needs no decision.)

Owen, same day: *"verify that when i run translate/simplify in foundry, they will correctly
use the 27b model in vllm and not the 9b."* There are **three independent guards**, and a
translate cannot silently run on the 9B past any of them:

1. `servedModelForRequest()` writes the profile's served id onto the request before
   `runJob`, and **refuses by name** if the request already asks for a different model. This
   is the guard that matters, because `vllmModel` is empty by default and empty means
   "whatever it is serving" — precisely the case where a wrong server would just be used.
2. `ensureTextServer` refuses to **adopt** a server on the port whose `/v1/models` id is not
   the profile's served name (see "somebody else's server" below), and **swaps** the server
   when the one that is up is the other profile.
3. Foundry's own `/v1/models` proof then checks the id it was handed against what the server
   reports, and refuses the mismatch in its own sentence.

## The lifecycle

```
noteTextQueueBusy()          cancel any pending idle stop
ensureTextServer(profileId)  ├─ unknown profile id           -> named throw
                             ├─ a start already in flight    -> JOIN it (one spawn)
                             ├─ a server up on another model -> stop it, then start (~95 s)
                             ├─ the port answers OUR name    -> ADOPT (used, never owned)
                             ├─ the port answers another     -> refuse by name
                             ├─ weights absent               -> STAGE them (see below)
                             ├─ external-gpu-job.lock held   -> refuse by name
                             └─ acquireGpu('vllm:text', {onYield: stop}) -> spawn -> ready
   … the pass runs …
noteTextQueueIdle(minutes)   0 (the default) stops it now; a window always has an end
```

**The GPU.** The text server is the **low-priority** holder, exactly as `GPU_OWNER_LLAMA` is
in `electron/gpu-arbiter.ts`: it registers an `onYield`, so a TTS acquire makes it stop and
hand the card over. This is the one place it differs from `vlm-page-server.ts`, which
deliberately registers *no* yield — yielding mid-conversion fails a ninety-minute run. A
text pass is minutes, and the card's real work is the renders.

It does **not** create `external-gpu-job.lock` (nothing inside the app does; that lock is a
convention with the Windows-side training tooling), but it **reads** it: while an external
job holds the card the server refuses to start, by name. The queue's `gpu` lane already
refuses to admit any step while that lock exists, so this is the second belt for the CLI
doors.

**Stopping.** `wslPkillGraceful` — the house's one graceful in-guest kill: SIGTERM inside the
distro, then poll until the process is gone, **never** SIGKILL, because force-killing a
process in a dxg GPU wait is what wedges the WSL VM until a reboot. Measured 2026-09-08: the
server exits within a few seconds of SIGTERM. An `alive` outcome is logged and left — the
distro is not terminated for a text pass, because a narration may be in it.

The pattern is `textServerProcessPattern(servedName)` —
`[v]llm\.entrypoints\.openai\.api_server.*--served-model-name <name>.*--port 8300` — and each
of its three parts is a server it must **not** kill:

- **`[v]llm`.** `wslPkillGraceful` cannot hit the classic trap (a `bash -lc 'pkill -f "vllm…"'`
  matches its own shell and kills itself first) because it runs `pgrep -af` under
  `wsl.exe --exec` — no shell at all — then `kill -TERM` on explicit pids. The bracket class is
  one character of insurance for every other place the string travels.
- **The served name.** This is what keeps "never stop somebody else's server" true even in the
  race the start-time check exists for: if another server takes 8300 while ours is coming up,
  our start fails, and the teardown of *our* spawn must not take *theirs* with it.
- **The port**, so a vLLM elsewhere — the page reader on 8077, a hand-started one — is never in
  scope at all.

**The orphan sweep.** `parallel-tts-bridge`'s unscoped sweep matches
`narrator\.compat\.(worker|app)|vllm`, and this server is a vllm process in the same distro.
It is added to that sweep's `excludeRe`, for the same reason the resident Listen server
already is: a batch job ending must not SIGTERM a cleanup halfway through a book. The
exclusion uses `TEXT_SERVER_PROTECT_RE` (no `--port`), because that clause is tested against
`ps` output and `ps` truncates long command lines where `pgrep` does not.

**App quit** stops it in `before-quit`, *before* the global WSL sweep, for `stopFoundry`'s
reason exactly.

## Somebody else's server

Foundry's rule for its reading server, kept verbatim: **if the port already answers, that
server is USED and never owned.** This file goes one step further, because the served name
is a record: a server on 8300 whose id is not the profile's served name is refused, never
used and never stopped.

`textServerRoute(url)` decides whether an endpoint is ours at all. **BookForge only manages
`http://localhost:8300/v1`.** Foundry's declared default `vllmUrl` is
`http://localhost:8000/v1` (`DEFAULT_VLLM_TEXT_ENDPOINT`) — and **8000 is Foundry's own
READING server**, serving dots.ocr. A machine that switches `llmServer` to `vllm` and leaves
that field alone points a cleanup at a vision model, so the route says so in a sentence fit
for a queue row rather than starting anything.

> **Set `Settings → Language model → vLLM URL` to `http://localhost:8300/v1`.**

## Staging

Owen, 2026-09-08, on a profile whose weights are not there: *"id rather it just switch to
the correct profile rather than failing."* So an absent model is not a refusal:
`ensureTextServer` downloads it — pinned revision, into the guest's ext4, resumable — with
the gigabytes on the queue row ("Downloading Qwen3.8-27B-AWQ-INT4 (4.2 / 21.0 GB)…"), and
then starts the server.

The download runs inside WSL through the same conda env that holds vllm (the `higgs3` env
carries `huggingface_hub`), by `electron/scripts/vllm/text_model_download.py`:
`snapshot_download(repo, revision=…, local_dir=…)` on a worker thread while the main thread
prints a JSON progress line every two seconds. `snapshot_download` resumes, so nothing is
deleted on a failure and the next attempt continues; the **one** thing that refuses by name
is a download that cannot happen at all — no network, no disk, a revision that is gone.

"Staged" means `config.json` + at least one `*.safetensors` + **no `.incomplete` blob** under
`<dir>/.cache`. That last clause is what keeps a half-finished stage from reading as done. A
directory somebody staged by hand is accepted as it is — `~/models/Qwen3.5-9B` on this PC was
downloaded before any of this existed, and re-fetching nineteen gigabytes to earn a marker of
our own would be an act of bookkeeping.

## Where the bracket lives

One bracket per spawn, in the file that owns the spawn. Two copies of a server lifetime is
one that leaks a card.

| door | what it spawns | bracket |
|---|---|---|
| `electron/queue-steps/foundry-job.ts` | `runJob` for a hosted `clean` / `translate` / `simplify` row | `ensureTextServer` + `servedModelForRequest` before, `noteTextQueueIdle` in `finally` |
| `electron/narration-clean-text.ts` (`cleanTextEpub`) | `foundry clean-text --epub` — the bare-EPUB failsafe, called by `processing-passes.ts` and `cli/narration-text-step.js` | same, inside the door |
| `cli/clean-step.js` | `runJob`, headless | same; stopped on the way out unless `--keep-server` |
| `cli/clean-lines-step.js` | `foundry clean-text --book` — the training corpus | same; `--keep-server` |

The two families differ in **who names the model**, and both are correct for what they
send. A door that composes a **request** (`foundry-job`, `clean-step`) has a request field to
fill, so it fills it with the profile's served id and refuses a different one. A door that
composes a **command line** (`cleanTextEpub`, `clean-lines-step`) sends the settings as they
are — empty `vllmModel` means "whatever it is serving", and the guard for those doors is
`ensureTextServer` itself, which refuses to adopt or start anything whose `/v1/models` id is
not the profile's served name. Either way the model that answers is proven before a block is
sent.

The two command-line doors also learn the flag: **`--server vllm` is written and
`--server ollama` is not** (so the Ollama line is byte-identical to what it was before vLLM
existed), and **`--model` is omitted when the model is empty** — never `--model ""`, because
empty is vLLM's meaningful default. The `--server` flag arrived in foundry `19f5e70` without
a version bump, so there is no number to gate on; a pre-`19f5e70` 1.2.0 answers
`unknown option --server`, which names itself.

## Settings

All in `<userData>/app-settings.json`, read by BookForge through `cleanTextEngineSettingsIn`
(`electron/narration-clean-text.ts`) — a **mirror** of Foundry's `readAppSettings`, clamp for
clamp, rather than an import, because `foundry-app/` is built output of a separate program
and importing into it is the subtree merge the seal exists to prevent.

| key | meaning |
|---|---|
| `llmServer` | `ollama` \| `vllm`. A property of the machine, not of a book. |
| `vllmUrl` | where that vLLM is. **Set it to `http://localhost:8300/v1`.** |
| `vllmModel` | the served id, or empty for "whatever it is serving". The host fills it in from the profile. |
| `keepServerWarmMinutes` | minutes an app-started server stays up after the work drains. 0 = stop on drain (the default); ceiling 240. Same key, same meaning as Foundry's. |
| `ollamaUrl`, `cleanTextModel` | the Ollama pair, kept beside the vLLM pair so switching back costs no retyping. |

## Open items

- **Depth.** 7 requests in flight is the measured ceiling at util 0.90, and Foundry's pool
  sends up to 12. Both Qwen 3.5 and 3.8 are **hybrid**: three of every four layers are Gated
  DeltaNet with a fixed recurrent state per sequence (~50 MB on the 9B, ~148 MB on the 27B at
  fp32), one in four is full attention with a tiny KV. vLLM pads the attention page to the
  state's size, so a sequence costs pages of ~1,600 tokens — which is why a 3.3 GB pool held
  only 22,420 tokens. **`--mamba-cache-dtype` is the knob that buys depth**; the KV dtype buys
  almost nothing here. Both are per-profile fields (`mambaCacheDtype`, `kvCacheDtype`), both
  `auto` today. Target: 12-16 in flight.
- **The 27B's own numbers.** `gpuMemUtil: 0.90` is inherited from the 9B and is UNMEASURED for
  20 GB of INT4 weights on a 24.5 GB card. First thing to revisit once a translation has run.
- **Drain by profile.** A queue holding a clean and a translate swaps the server per row
  (~95 s each). Foundry's suggestion — order the drain by profile so a mixed queue swaps
  once — is a real optimisation and belongs in the **scheduler**, not in the arbiter. Not
  built.
- **Settings surface.** Nothing in BookForge's own UI shows the text server's state today;
  `textServerStatus()` exists for it.
