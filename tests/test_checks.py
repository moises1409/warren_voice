import datetime as dt

import pytest
from conftest import load, open_keys

from store import PrepStore, load_dossiers

# What the deterministic checks must find in each mock client. Each client is
# seeded with these situations on purpose; see docs/meeting-prep-design.md.
EXPECTED = {
    "c-001": {
        "family.abroad:fam-2",
        "note.c-001-ext",
        "succession.es-real-estate",
        "wealth.concentration:ast-5",
    },
    "c-002": {
        "family.abroad:fam-3",
        "family.abroad:fam-4",
        "general.contact.stale",
        "note.c-002-flat",
        "succession.excluded:fam-2",
        "succession.uk-situs",
        "succession.us-situs",
        "succession.will.unknown",
        "wealth.inflow.upcoming:cf-2",
    },
    "c-003": {
        "family.partner.unknown",
        "liability.incomplete:lia-2",
        "note.c-003-sale",
        "succession.heirs.undetermined",
        "succession.will.unknown",
        "wealth.cashflow.deficit",
    },
    "c-004": {
        "asset.incomplete:ast-6",
        "cashflow.incomplete:cf-3",
        "family.abroad:fam-1",
        "family.incomplete:fam-2",
        "note.c-004-ext",
        "succession.will.unknown",
        "wealth.cashflow.deficit",
    },
    "c-005": {
        "asset.incomplete:ast-3",
        "asset.incomplete:ast-4",
        "family.children.unknown",
        "family.marital_status.unknown",
        "note.c-005-home",
        "note.c-005-spouse",
        "succession.will.unknown",
        "wealth.expenses.none",
        "wealth.income.none",
        "wealth.mortgage.no_property:lia-1",
        "wealth.pension.none",
    },
    "c-006": {
        "cashflow.incomplete:cf-2",
        "family.incomplete:fam-1",
        "family.incomplete:fam-3",
        "note.c-006-marie",
        "succession.fr-real-estate",
        "succession.regime.unknown",
        "succession.will.unknown",
        "wealth.pension.none",
    },
    "c-007": {
        "asset.incomplete:ast-3",
        "family.children.undetailed",
        "family.partner.unknown",
        "general.contact.stale",
        "note.c-007-chloe",
        "note.c-007-hugo",
        "note.c-007-spouse",
        "pension.incomplete:pen-1",
        "succession.will.unknown",
        "wealth.expenses.none",
    },
    "c-008": {
        "family.abroad:fam-2",
        "family.abroad:fam-3",
        "family.child.age:fam-2",
        "note.c-008-boat",
        "succession.es-heir:fam-2",
        "succession.es-real-estate",
        "succession.regime.unknown",
        "succession.us-situs",
        "wealth.cashflow.deficit",
        "wealth.inflow.upcoming:cf-3",
    },
}


def test_every_mock_client_is_covered() -> None:
    assert {d.client.id for d in load_dossiers()} == set(EXPECTED)


@pytest.mark.parametrize("client_id", sorted(EXPECTED))
def test_mock_client_findings(client_id: str) -> None:
    assert open_keys(load(client_id)) == EXPECTED[client_id]


def test_blank_client_asks_for_the_basics(blank: PrepStore) -> None:
    assert open_keys(blank) == {
        "wealth.income.none",
        "wealth.expenses.none",
        "wealth.pension.none",
        "family.marital_status.unknown",
        "family.children.unknown",
        "succession.will.unknown",
    }


def test_note_is_flagged_until_the_structured_data_carries_it() -> None:
    store = load("c-001")
    point = next(p for p in store.open_points() if p.rule_key == "note.c-001-ext")
    assert point.kind == "inconsistency"
    assert point.text.startswith(
        "Activity note of 12 May 2026: it mentions about CHF 4 million"
    )
    assert "structured fields of the CRM" in point.text

    # A position that is too small does not account for what the note says.
    store.upsert_asset(
        type="funds", amount=1_000_000, currency="CHF", bank="Julius Baer"
    )
    assert "note.c-001-ext" in open_keys(store)

    store.upsert_asset("ast-8", amount=3_800_000)
    assert "note.c-001-ext" not in open_keys(store)


def test_note_already_in_the_structured_data_raises_nothing() -> None:
    # Elena's second note says Lea lives in London, and the CRM has it.
    assert "note.c-001-lea" not in open_keys(load("c-001"))
    # Henrik's note mentions the gift to Astrid, which is recorded; the Handelsbanken account is not.
    assert open_keys(load("c-004")) >= {"note.c-004-ext"}
    assert "note.c-004-gift" not in open_keys(load("c-004"))


def test_family_facts_from_a_note_close_when_recorded() -> None:
    store = load("c-007")
    assert {"note.c-007-spouse", "note.c-007-chloe", "note.c-007-hugo"} <= open_keys(
        store
    )

    store.upsert_family_member(relation="spouse", name="Pierre Fontaine")
    store.upsert_family_member(relation="child", name="Chloé", birth_year=2012)

    assert open_keys(store) & {
        "note.c-007-spouse",
        "note.c-007-chloe",
        "note.c-007-hugo",
    } == {"note.c-007-hugo"}


def test_mortgage_is_consistent_once_a_property_exists(blank: PrepStore) -> None:
    mortgage = blank.upsert_liability(
        type="mortgage", amount=1, currency="CHF", bank="UBS", country="CH"
    )
    key = f"wealth.mortgage.no_property:{mortgage.id}"
    assert key in open_keys(blank)

    blank.upsert_asset(type="real_estate", amount=2, currency="CHF", country="CH")
    assert key not in open_keys(blank)


def test_one_off_flow_needs_a_date_and_past_inflows_are_not_topics(
    blank: PrepStore,
) -> None:
    flow = blank.upsert_cash_flow(
        direction="income",
        frequency="one_off",
        type="inheritance",
        amount=1,
        currency="CHF",
    )
    assert f"cashflow.incomplete:{flow.id}" in open_keys(blank)

    blank.upsert_cash_flow(flow.id, date=dt.date(2025, 6, 1))
    assert open_keys(blank).isdisjoint(
        {f"cashflow.incomplete:{flow.id}", f"wealth.inflow.upcoming:{flow.id}"}
    )

    blank.upsert_cash_flow(flow.id, date=dt.date(2027, 6, 1))
    assert f"wealth.inflow.upcoming:{flow.id}" in open_keys(blank)


def test_no_pension_is_not_flagged_after_retirement_age(blank: PrepStore) -> None:
    blank.state.client.date_of_birth = dt.date(1950, 1, 1)
    blank.set_stage("wealth")
    assert "wealth.pension.none" not in open_keys(blank)


def test_bankable_portfolio_is_not_a_concentration(blank: PrepStore) -> None:
    blank.upsert_asset(type="equities", amount=9_000_000, currency="CHF", bank="UBS")
    blank.upsert_asset(type="cash", amount=100_000, currency="CHF", bank="UBS")
    home = blank.upsert_asset(type="real_estate", amount=500_000, currency="CHF")
    assert not {k for k in open_keys(blank) if k.startswith("wealth.concentration")}

    blank.upsert_asset(home.id, amount=20_000_000)
    assert f"wealth.concentration:{home.id}" in open_keys(blank)


def test_family_questions_close_as_answers_arrive(blank: PrepStore) -> None:
    blank.set_family(marital_status="married", has_children=False)
    assert open_keys(blank) >= {"family.partner.unknown"}
    assert "family.children.unknown" not in open_keys(blank)

    spouse = blank.upsert_family_member(relation="spouse", name="Sam")
    assert "family.partner.unknown" not in open_keys(blank)
    assert f"family.incomplete:{spouse.id}" in open_keys(blank)

    blank.upsert_family_member(
        spouse.id, birth_year=1982, residence={"city": "Bern", "country": "CH"}
    )
    assert not {k for k in open_keys(blank) if k.startswith("family.")}
