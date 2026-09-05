"""Assembly: manifest -> chapter audio -> AAC -> one m4b, plus the VTT.

Reads ONLY a Manifest. Nothing in here opens session-state.json or knows what an
e2a session directory looks like; `narrator.render.session_v1` is the only bridge
between the two.
"""

from .run import AssembleResult, assemble  # noqa: F401
