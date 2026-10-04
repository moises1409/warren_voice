import json

import pytest
from conftest import open_keys
from pydantic import ValidationError

from store import ItemNotFoundError, PrepStore
from summary import compute_totals


def test_new_asset_gets_an_id_and_a_bankable_default(blank: PrepStore) -> None:
    cash = blank.upsert_asset(type="cash", amount=100_000, currency="chf")
    home = blank.upsert_asset(type="real_estate", label="Home")
    crypto = blank.upsert_asset(type="crypto")

    assert (cash.id, home.id, crypto.id) == ("ast-1", "ast-2", "ast-3")
    assert cash.currency == "CHF"
    assert (cash.bankable, home.bankable, crypto.bankable) == (True, False, None)


def test_naming_a_bank_makes_an_asset_bankable(blank: PrepStore) -> None:
    gold = blank.upsert_asset(type="precious_metals", bank="UBS")
    assert gold.bankable is True


def test_update_keeps_fields_that_were_not_mentioned(blank: PrepStore) -> None:
    asset = blank.upsert_asset(type="equities", amount=500_000, currency="USD")

    updated = blank.upsert_asset(asset.id, amount=650_000, bank="UBS")

    assert len(blank.state.assets) == 1
    assert (updated.amount, updated.currency, updated.bank) == (650_000, "USD", "UBS")


def test_invalid_values_are_rejected_and_nothing_is_stored(blank: PrepStore) -> None:
    rev = blank.state.rev
    with pytest.raises(ValidationError):
        blank.upsert_asset(type="yacht")
    with pytest.raises(ItemNotFoundError):
        blank.upsert_asset("ast-99", amount=1)

    assert blank.state.assets == []
    assert blank.state.rev == rev


def test_every_mutation_bumps_the_revision_and_notifies(blank: PrepStore) -> None:
    seen: list[int] = []
    blank.subscribe(lambda state: seen.append(state.rev))

    blank.upsert_liability(type="mortgage", amount=1_000_000, currency="CHF")
    blank.set_family(marital_status="single")
    blank.set_stage("family")

    assert seen == [1, 2, 3]


def test_removing_an_item_clears_references_to_it(blank: PrepStore) -> None:
    home = blank.upsert_asset(type="real_estate", label="Home")
    mortgage = blank.upsert_liability(type="mortgage", secured_by_asset_id=home.id)
    spouse = blank.upsert_family_member(relation="spouse", name="Sam")
    child = blank.upsert_family_member(
        relation="child", name="Kim", other_parent_id=spouse.id
    )

    blank.remove_item(home.id)
    blank.remove_item(spouse.id)

    assert blank.state.assets == []
    assert blank.state.liabilities[0].id == mortgage.id
    assert blank.state.liabilities[0].secured_by_asset_id is None
    assert blank.state.family.members[0].id == child.id
    assert blank.state.family.members[0].other_parent_id is None
    with pytest.raises(ItemNotFoundError):
        blank.remove_item("ast-99")


def test_adding_a_child_records_that_the_client_has_children(blank: PrepStore) -> None:
    blank.upsert_family_member(relation="child", name="Kim", birth_year=2010)
    assert blank.state.family.has_children is True


def test_other_parent_must_exist(blank: PrepStore) -> None:
    with pytest.raises(ItemNotFoundError):
        blank.upsert_family_member(relation="child", other_parent_id="fam-9")


def test_rule_point_closes_when_the_data_fixes_it(blank: PrepStore) -> None:
    asset = blank.upsert_asset(type="equities", amount=500_000)
    key = f"asset.incomplete:{asset.id}"
    assert key in open_keys(blank)

    blank.upsert_asset(asset.id, currency="CHF", country="CH", bank="UBS")

    point = next(p for p in blank.state.meeting_points if p.rule_key == key)
    assert point.status == "resolved"


def test_rule_point_text_follows_the_data(blank: PrepStore) -> None:
    asset = blank.upsert_asset(type="equities", label="Portfolio")
    key = f"asset.incomplete:{asset.id}"

    def text() -> str:
        return next(p.text for p in blank.state.meeting_points if p.rule_key == key)

    assert text() == "Portfolio: value, currency, country and custodian bank not known."
    blank.upsert_asset(asset.id, amount=1, currency="CHF")
    assert text() == "Portfolio: country and custodian bank not known."


def test_dismissed_rule_point_stays_dismissed(blank: PrepStore) -> None:
    point = next(
        p for p in blank.state.meeting_points if p.rule_key == "wealth.income.none"
    )

    # Closing a rule point by hand is a dismissal, whichever word is used.
    blank.update_meeting_point(point.id, status="resolved")
    blank.upsert_asset(type="cash")

    points = [
        p for p in blank.state.meeting_points if p.rule_key == "wealth.income.none"
    ]
    assert [p.status for p in points] == ["dismissed"]


def test_resolved_rule_point_reopens_when_the_problem_returns(blank: PrepStore) -> None:
    salary = blank.upsert_cash_flow(
        direction="income",
        frequency="recurring",
        type="salary",
        amount=1,
        currency="CHF",
    )
    assert "wealth.income.none" not in open_keys(blank)

    blank.remove_item(salary.id)

    assert "wealth.income.none" in open_keys(blank)
    assert (
        sum(p.rule_key == "wealth.income.none" for p in blank.state.meeting_points) == 1
    )


def test_agent_points_are_independent_of_the_checks(blank: PrepStore) -> None:
    point = blank.add_meeting_point("Ask about the succession plan.", "wealth")
    blank.update_meeting_point(point.id, status="resolved")
    blank.upsert_asset(type="cash")

    stored = next(p for p in blank.state.meeting_points if p.id == point.id)
    assert (stored.source, stored.status, stored.rule_key) == (
        "agent",
        "resolved",
        None,
    )


def test_snapshot_is_camel_case_json(blank: PrepStore) -> None:
    blank.upsert_cash_flow(direction="income", type="salary", frequency="recurring")
    snapshot = json.loads(blank.snapshot())

    assert snapshot["rev"] == 1
    assert snapshot["client"]["dateOfBirth"] == "1980-01-01"
    assert snapshot["cashFlows"][0]["id"] == "cf-1"
    assert "meetingPoints" in snapshot
    assert "cash_flows" not in snapshot


def test_totals_convert_to_base_currency_and_skip_unvalued(blank: PrepStore) -> None:
    blank.upsert_asset(type="cash", amount=100_000, currency="CHF", bank="warren & cie")
    blank.upsert_asset(type="equities", amount=100_000, currency="USD", bank="UBS")
    blank.upsert_asset(type="real_estate", amount=1_000_000, currency="EUR")
    blank.upsert_asset(type="art_collectibles")
    blank.upsert_liability(type="mortgage", amount=500_000, currency="EUR")

    totals = compute_totals(blank.state, blank.settings)

    assert totals.aum_bank == 100_000
    assert totals.aum_external == 80_000
    assert totals.bankable == 180_000
    assert totals.non_bankable == 940_000
    assert totals.liabilities == 470_000
    assert totals.net_worth == 650_000
    assert totals.unvalued == 1
