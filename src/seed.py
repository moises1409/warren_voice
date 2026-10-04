"""Write the starting session of every client, so the page shows meeting points,
the simulation and the review before any conversation.

    uv run python src/seed.py           # clients with no session, or one nobody worked on
    uv run python src/seed.py --force   # every client: discards the sessions in progress

Run it after changing data/clients.json, the rules or the checks.
"""

from __future__ import annotations

import sys

from sessions import SessionStore
from store import PrepStore, load_dossiers


def seed(force: bool = False, sessions: SessionStore | None = None) -> list[str]:
    """Returns the ids of the clients whose session was written."""
    sessions = sessions or SessionStore()
    written = []
    for dossier in load_dossiers():
        client_id = dossier.client.id
        saved = sessions.load(client_id)
        if saved and saved.rev > 0 and not force:
            continue
        # A new session, not the saved one: `reset` ignores what is on disk.
        PrepStore.load(client_id, sessions=sessions, reset=True).save()
        written.append(client_id)
    return written


if __name__ == "__main__":
    done = seed(force="--force" in sys.argv)
    print(f"seeded {len(done)} session(s): {', '.join(done) or 'none'}")
