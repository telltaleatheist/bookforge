"""The old headless door, so BookForge's bridges need no change on the day.

Two entry points, mirroring the two ebook2audiobook scripts the bridges spawn:

    python -m narrator.compat.app     ebook2audiobook `app.py --headless ...`
    python -m narrator.compat.worker  ebook2audiobook `worker.py ...`

They accept the SAME flags those two scripts accept today and route them onto
narrator's own modules. Every flag - accepted, refused or ignored - is in
`compat/FLAGS.md`, with the bridge that passes it.

This package is scaffolding. Each flag is retired as its bridge is modernized
(docs/NARRATOR_PLAN.md step 5), and the package disappears when the last one is.
"""
