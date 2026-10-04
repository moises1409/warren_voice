"""Where preparation sessions are kept between conversations.

One JSON file per client under data/sessions/. The agent writes it after every
change; the frontend reads it to show a client as it was left, meeting points
included, without a conversation. This works while both share a disk. Deployed
as separate services they do not: give `PrepStore` another implementation of
the same three methods, backed by a database.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from pydantic import ValidationError

from fx import DATA_DIR
from models import PrepState

logger = logging.getLogger("agent")

SESSIONS_DIR = DATA_DIR / "sessions"


class SessionStore:
    def __init__(self, directory: Path = SESSIONS_DIR) -> None:
        self.directory = directory

    def _path(self, client_id: str) -> Path:
        return self.directory / f"{client_id}.json"

    def load(self, client_id: str) -> PrepState | None:
        path = self._path(client_id)
        if not path.exists():
            return None
        try:
            return PrepState.model_validate_json(path.read_text(encoding="utf-8"))
        except (ValidationError, ValueError, OSError):
            # Written by an older version, or cut short: start from the client file.
            logger.warning("ignoring unreadable session %s", path.name)
            return None

    def save(self, state: PrepState) -> None:
        path = self._path(state.client.id)
        try:
            self.directory.mkdir(parents=True, exist_ok=True)
            # Write beside the file and swap, so a reader never sees half a file.
            temporary = path.with_suffix(".tmp")
            temporary.write_text(state.model_dump_json(by_alias=True), encoding="utf-8")
            os.replace(temporary, path)
        except OSError:
            # A locked file must not take the conversation down; the next change retries.
            logger.warning("could not save session %s", path.name, exc_info=True)

    def delete(self, client_id: str) -> None:
        self._path(client_id).unlink(missing_ok=True)
