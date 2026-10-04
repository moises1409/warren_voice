import datetime as dt

import pytest
from dotenv import load_dotenv

from fx import Settings
from models import Client, Dossier, Place
from store import PrepStore

load_dotenv(".env.local")

# Pinned so age- and date-based checks stay stable.
TODAY = dt.date(2026, 10, 3)


@pytest.fixture
def settings() -> Settings:
    return Settings(
        house_bank="Warren & Cie",
        base_currency="CHF",
        fx_to_base={"CHF": 1.0, "EUR": 0.94, "USD": 0.8},
    )


@pytest.fixture
def blank(settings: Settings) -> PrepStore:
    """A client about whom nothing but the CRM header is known."""
    dossier = Dossier(
        client=Client(
            id="c-test",
            name="Test Client",
            date_of_birth=dt.date(1980, 1, 1),
            domicile=Place(city="Bern", country="CH"),
            segment="Independent",
            risk_score="Medium",
            performance_ytd_pct=1.0,
            last_contact=dt.date(2026, 9, 1),
        )
    )
    return PrepStore(dossier, settings, today=TODAY)


def load(client_id: str) -> PrepStore:
    return PrepStore.load(client_id, today=TODAY)


def open_keys(store: PrepStore) -> set[str]:
    return {p.rule_key for p in store.open_points() if p.rule_key}
