# September 16 audit reconciliation — September 23, 2026

The September 16 Codex audit was interrupted by usage-limit errors in all
three subagents. Its subsequent scheduled reminders did not establish completed
work. This report reconciles that unfinished audit with the repositories as
observed on September 23 at approximately 04:09 Eastern. It does not attribute
later contributors' changes to the interrupted audit.

## Current source and publication

All three working trees were clean before this report was added:

- BookForge: `c9c26e38`, including the Foundry `acf63c2` source mirror.
- Foundry: `acf63c2`.
- Crucible: `b95ac38`, version 1.0.23.

GitHub release metadata reports Crucible
[1.0.23](https://github.com/telltaleatheist/crucible/releases/tag/v1.0.23)
as a prerelease and
[1.0.22](https://github.com/telltaleatheist/crucible/releases/tag/v1.0.22)
as a non-prerelease. The newest listed BookForge and Foundry releases remain
[0.1.2927](https://github.com/telltaleatheist/bookforge/releases/tag/v0.1.2927)
and [2.0.2](https://github.com/telltaleatheist/foundry/releases/tag/v2.0.2),
both prereleases from September 16. Their published binaries do not establish
validation of the substantially newer source checkouts. No release assets were
rebuilt, replaced or promoted during this reconciliation.

## Previously unfinished findings

Current source now includes the local model selection settings contract
(`local_models` and `local_model_choices`) and WSL activation rollback handling.
BookForge history includes `226e6da7` (recheck demand after following another
app's preparation task) and `4cdc50b6` (ignore a stale server response after a
selection change). Foundry includes the corresponding preparation correction
`71fec92`. These findings must not be reimplemented from the old audit plan.

On current Crucible source, native Windows Python 3.11 completed this focused
CPU-only command successfully: **14 tests passed**.

```text
python -m pytest tests/test_host_migration_faults.py tests/test_settings_local_models.py -q
```

These tests use disposable fixtures, including loopback HTTP peers. This is
specific regression evidence, not a full suite, fresh Windows installation,
GPU inference, or live WSL migration acceptance result. The earlier CPU fixture
portability concerns and broader app behavior were not revalidated in this run.

## Live workload and remaining evidence

Read-only `nvidia-smi` reported 78% utilization and 5,307 MiB allocated on the
RTX 3090 Ti. The recent text in the previously supplied Claude conversation no
longer establishes completion of the original screen/ladder: it discusses later
voice work and another pending ladder. No GPU workload, service, model inventory
or WSL installation was changed. The old ten-minute estimate is not current
availability evidence.

The September 16 release report remains historical evidence for the Mac
installation, explicit-model inference and existing-Ollama tests. Later source
adds Mac page inference and changes the connection contract; its current
behavior cannot be judged solely against that report's old limitations. Current
source and INTENT.md need to govern any new acceptance run. The intent document
itself currently contains both an Ollama-style network-access statement and an
older pairing requirement; reconcile those before a new connection audit.

No current clean-machine Windows/WSL acceptance or Mac signing/notarization
result was established here. The September 16 scheduled report automation was
paused through the app on September 23, as its instructions require after the
report; the obsolete reminder will no longer keep replaying the old plan.
