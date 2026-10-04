"""The death-of-the-client simulation: who inherits, what it costs, where it comes from.

The rules in rules/succession.yaml are illustrative; these tests pin the engine's
behaviour on them, not the correctness of the tax rates.
"""

import pytest
from conftest import load, open_keys

from store import PrepStore
from succession import Rule, RuleSet, simulate


def result(store: PrepStore) -> dict:
    return store.state.succession


def by_rule(store: PrepStore) -> dict[str, float]:
    totals: dict[str, float] = {}
    for tax in result(store)["taxes"]:
        totals[tax["ruleId"]] = totals.get(tax["ruleId"], 0) + tax["high"]
    return totals


def flat_rule(**overrides) -> Rule:
    base = {
        "id": "test",
        "layer": "situs",
        "topic": "Test",
        "country": "FR",
        "when": {"situs": "FR"},
        "per": "heir",
        "currency": "CHF",
        "allowance": {},
        "brackets": [(None, 0.10)],
        "expert": "tax_succession",
        "source": "test",
    }
    return Rule(**{**base, **overrides})


def rules(*items: Rule) -> RuleSet:
    return RuleSet(
        version="test", illustrative=True, experts={}, assumptions=[], rules=list(items)
    )


def test_spouse_takes_half_and_children_share_the_rest() -> None:
    store = load("c-001")
    heirs = {h["label"]: h for h in result(store)["heirs"]}

    assert {k: v["sharePct"] for k, v in heirs.items()} == {
        "Markus Brunner": 50,
        "Lea Brunner": 25,
        "Jonas Brunner": 25,
    }
    assert sum(h["gross"] for h in heirs.values()) == pytest.approx(
        result(store)["estate"]
    )
    # A quarter of the assets held at the bank would pass to each child.
    assert heirs["Lea Brunner"]["aumAtBank"] == pytest.approx(8_150_000 / 4)


def test_children_alone_share_everything_and_partners_are_left_out() -> None:
    store = load("c-002")
    r = result(store)

    assert [(h["label"], h["sharePct"]) for h in r["heirs"]] == [
        ("Oliver Whitfield", 50),
        ("Emily Whitfield", 50),
    ]
    assert {e["memberId"] for e in r["excluded"]} == {"fam-1", "fam-2"}
    assert "succession.excluded:fam-2" in open_keys(store)
    # A former spouse is left out without a meeting point: nothing to discuss there.
    assert "succession.excluded:fam-1" not in open_keys(store)


def test_family_that_is_not_modelled_gets_no_split() -> None:
    store = load("c-003")
    r = result(store)

    assert r["heirsModelled"] is False
    assert r["heirs"] == []
    assert "succession.heirs.undetermined" in open_keys(store)


def test_estate_is_net_of_debt_and_reaches_the_heirs_less_tax() -> None:
    store = load("c-008")
    r = result(store)

    assert r["estate"] == pytest.approx(12_902_000)
    assert r["netToHeirs"] == pytest.approx(r["estate"] - r["costHigh"])
    assert sum(h["net"] for h in r["heirs"]) == pytest.approx(r["netToHeirs"])
    assert sum(t["high"] for t in r["taxes"]) == pytest.approx(r["costHigh"])


def test_foreign_property_is_taxed_net_of_its_mortgage() -> None:
    store = load("c-008")
    marbella = [t for t in result(store)["taxes"] if t["ruleId"] == "es-real-estate"]

    # EUR 2.3m villa less the EUR 0.7m mortgage secured on it, in CHF.
    assert sum(t["base"] for t in marbella) == pytest.approx(
        (2_300_000 - 700_000) * 0.94
    )


def test_direct_us_shares_are_taxed_and_a_non_us_fund_is_not() -> None:
    whitfield = load("c-002")
    us = next(t for t in result(whitfield)["taxes"] if t["ruleId"] == "us-situs")
    assert us["assetIds"] == ["ast-2", "ast-4"]
    assert us["expert"] == "us_cross_border"
    # The treaty may remove it, so the low end of the range is nil.
    assert us["low"] == 0 and us["high"] > 1_000_000

    # Elena's global equity funds are domiciled in Ireland: no US rule fires.
    assert "us-situs" not in by_rule(load("c-001"))


def test_recording_the_situs_changes_the_result(blank: PrepStore) -> None:
    blank.set_family(marital_status="single")
    blank.upsert_family_member(relation="child", name="Kim", birth_year=2000)
    shares = blank.upsert_asset(
        type="equities", amount=5_000_000, currency="USD", country="CH", bank="UBS"
    )
    assert result(blank)["costHigh"] == 0

    blank.upsert_asset(shares.id, situs="US", holding="direct")
    assert by_rule(blank).get("us-situs", 0) > 0
    assert "succession.us-situs" in open_keys(blank)

    blank.upsert_asset(shares.id, situs="IE", holding="fund")
    assert result(blank)["costHigh"] == 0
    assert "succession.us-situs" not in open_keys(blank)


def test_heir_country_adds_only_what_the_assets_do_not_already_trigger() -> None:
    store = load("c-008")
    heirs = {h["label"]: h for h in result(store)["heirs"]}
    extra = next(t for t in result(store)["taxes"] if t["ruleId"] == "es-heir")

    # Diego and Lucía inherit the same; only Diego lives in a country that taxes the heir.
    assert heirs["Diego Ortega"]["gross"] == heirs["Lucía Ortega"]["gross"]
    assert heirs["Diego Ortega"]["tax"] == pytest.approx(
        heirs["Lucía Ortega"]["tax"] + extra["high"]
    )
    point = next(
        p for p in store.open_points() if p.rule_key == "succession.es-heir:fam-2"
    )
    assert (point.kind, point.section, point.expert) == (
        "inefficiency",
        "family",
        "relocation",
    )
    assert point.amount == pytest.approx(extra["high"])


def test_exempt_relation_pays_nothing(blank: PrepStore, settings) -> None:
    blank.set_family(marital_status="married")
    blank.upsert_family_member(relation="spouse", name="Sam")
    blank.upsert_family_member(relation="child", name="Kim")
    blank.upsert_asset(
        type="real_estate", amount=1_000_000, currency="CHF", country="FR"
    )

    r = simulate(
        blank.state,
        settings,
        rules(flat_rule(allowance={"spouse": "exempt", "child": 100_000})),
    )

    [tax] = r.taxes
    assert tax.heir_id == blank.state.family.members[1].id
    # The child's half, less the allowance, at ten percent.
    assert tax.high == pytest.approx((500_000 - 100_000) * 0.10)


def test_progressive_scale_and_currency_of_the_thresholds(
    blank: PrepStore, settings
) -> None:
    blank.set_family(marital_status="single")
    blank.upsert_family_member(relation="child", name="Kim")
    blank.upsert_asset(type="real_estate", amount=940_000, currency="CHF", country="FR")
    rule = flat_rule(currency="EUR", brackets=[(500_000, 0.10), (None, 0.30)])

    r = simulate(blank.state, settings, rules(rule))

    # CHF 940k is EUR 1m: 500k at 10% and 500k at 30%, converted back at 0.94.
    assert r.taxes[0].high == pytest.approx((50_000 + 150_000) * 0.94)


def test_client_share_limits_what_is_in_the_estate(blank: PrepStore) -> None:
    home = blank.upsert_asset(type="real_estate", amount=2_000_000, currency="CHF")
    assert result(blank)["estate"] == 2_000_000

    blank.upsert_asset(home.id, client_share_pct=50)
    assert result(blank)["estate"] == 1_000_000


def test_taxes_above_liquid_assets_are_flagged(blank: PrepStore) -> None:
    blank.set_family(marital_status="single")
    blank.upsert_family_member(relation="child", name="Kim")
    blank.upsert_asset(
        type="real_estate", amount=10_000_000, currency="USD", country="US"
    )
    blank.upsert_asset(type="cash", amount=100_000, currency="CHF", bank="UBS")

    r = result(blank)
    assert r["liquidityGap"] == pytest.approx(r["costHigh"] - 100_000)
    assert "succession.liquidity" in open_keys(blank)


def test_open_questions_about_the_succession_close_when_answered(
    blank: PrepStore,
) -> None:
    blank.set_family(marital_status="married")
    blank.upsert_family_member(relation="spouse", name="Sam")
    blank.upsert_family_member(relation="child", name="Kim")
    assert {"succession.will.unknown", "succession.regime.unknown"} <= open_keys(blank)

    blank.set_family(marital_regime="separation_of_property", has_will=True)
    assert not {k for k in open_keys(blank) if k.startswith("succession.")}


def test_result_says_which_rules_produced_it() -> None:
    r = result(load("c-001"))

    assert r["rulesVersion"] == "2026-10-demo"
    assert r["illustrative"] is True
    assert r["assumptions"]
    assert all(t["source"] for t in r["taxes"])
