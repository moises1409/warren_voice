"""What the client's death would cost and who would receive what.

A deterministic engine over the rules in `rules/succession.yaml`. No model is
involved: every figure can be traced to a rule and its source. The rules decide
what is taxed and how; this module only applies them.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import Field

from fx import Settings
from models import (
    DEFAULT_BANKABLE,
    Asset,
    CamelModel,
    Dossier,
    FamilyMember,
    display_name,
)

RULES_PATH = Path(__file__).resolve().parent.parent / "rules" / "succession.yaml"

# Asset types that can be turned into cash to pay a tax bill.
LIQUID_TYPES = {"cash", "equities", "bonds", "funds", "structured_products"}
# Securities are treated as domiciled where they are booked unless a situs is recorded.
SECURITY_TYPES = {"equities", "bonds", "funds", "structured_products"}

Layer = Literal["situs", "heir"]


class Tax(CamelModel):
    """One rule that fired, for one heir or for the whole estate."""

    rule_id: str
    layer: Layer
    topic: str
    country: str
    asset_ids: list[str] = Field(default_factory=list)
    # The heir who bears it; none for a tax on the estate as a whole.
    heir_id: str | None = None
    base: float
    low: float
    high: float
    expert: str
    source: str


class Heir(CamelModel):
    # The family member, or none for an heir who is known to exist but is not recorded.
    member_id: str | None = None
    label: str
    relation: str
    country: str | None = None
    share_pct: float
    gross: float
    tax: float
    net: float
    # The part of `gross` that is assets held at the house bank.
    aum_at_bank: float


class Excluded(CamelModel):
    member_id: str
    reason: str


class Succession(CamelModel):
    rules_version: str
    illustrative: bool
    assumptions: list[str]
    missing_inputs: list[str]
    experts: dict[str, str]
    # False when the family is one the statutory split here does not cover.
    heirs_modelled: bool
    estate: float
    cost_low: float
    cost_high: float
    net_to_heirs: float
    liquid_assets: float
    # Taxes not covered by liquid assets; zero when they are.
    liquidity_gap: float
    taxes: list[Tax]
    heirs: list[Heir]
    excluded: list[Excluded]


@dataclass(frozen=True)
class Rule:
    id: str
    layer: Layer
    topic: str
    country: str
    when: dict[str, Any]
    per: Literal["heir", "estate"]
    currency: str
    allowance: dict[str, Any]
    brackets: list[tuple[float | None, float]]
    expert: str
    source: str
    low_factor: float = 1.0


@dataclass(frozen=True)
class RuleSet:
    version: str
    illustrative: bool
    experts: dict[str, str]
    assumptions: list[str]
    rules: list[Rule] = field(default_factory=list)


@lru_cache(maxsize=4)
def load_rules(path: Path = RULES_PATH) -> RuleSet:
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    return RuleSet(
        version=str(raw["version"]),
        illustrative=raw.get("status") != "validated",
        experts=raw["experts"],
        assumptions=raw["assumptions"],
        rules=[
            Rule(
                id=r["id"],
                layer=r["layer"],
                topic=r["topic"],
                country=r["country"],
                when=r["when"],
                per=r["per"],
                currency=r["currency"],
                allowance=r.get("allowance", {}),
                brackets=[(limit, rate) for limit, rate in r["brackets"]],
                expert=r["expert"],
                source=r["source"],
                low_factor=float(r.get("low_factor", 1.0)),
            )
            for r in raw["rules"]
        ],
    )


def situs_of(asset: Asset) -> str | None:
    """The country whose tax law attaches to the asset."""
    return (asset.situs or asset.country or "").upper() or None


def _progressive(amount: float, brackets: list[tuple[float | None, float]]) -> float:
    tax, floor = 0.0, 0.0
    for limit, rate in brackets:
        if limit is None or amount <= limit:
            return tax + max(amount - floor, 0.0) * rate
        tax += (limit - floor) * rate
        floor = limit
    return tax


def _tax(rule: Rule, base: float, relation: str, settings: Settings) -> float | None:
    """Tax in base currency on `base` (base currency). None when the relation is exempt."""
    allowance = rule.allowance.get(relation, rule.allowance.get("any", 0))
    if allowance == "exempt":
        return None
    rate = settings.fx_to_base.get(rule.currency, 1.0)
    taxable = base / rate - float(allowance)
    return _progressive(max(taxable, 0.0), rule.brackets) * rate


def _matches(rule: Rule, asset: Asset) -> bool:
    when = rule.when
    if "situs" in when and situs_of(asset) != when["situs"]:
        return False
    if "asset_types" in when and asset.type not in when["asset_types"]:
        return False
    if asset.type in when.get("asset_types_not", []):
        return False
    return asset.holding not in when.get("holding_not", [])


@dataclass
class _Heir:
    member: FamilyMember | None
    label: str
    relation: str  # as the rules name it: spouse, child, other
    share: float

    @property
    def id(self) -> str | None:
        return self.member.id if self.member else None

    @property
    def country(self) -> str | None:
        if self.member and self.member.residence and self.member.residence.country:
            return self.member.residence.country.upper()
        return None


def _heirs(dossier: Dossier) -> tuple[list[_Heir], list[Excluded], list[str], bool]:
    """The statutory heirs with their shares, who is left out, and what could not be told."""
    family = dossier.family
    missing: list[str] = []
    excluded: list[Excluded] = []

    status = family.marital_status
    if status is None:
        missing.append("Marital status")
    statutory_relation = {"married": "spouse", "registered_partnership": "partner"}.get(
        status or ""
    )
    spouse: _Heir | None = None
    for member in family.members:
        if member.relation == "ex_spouse":
            excluded.append(Excluded(member_id=member.id, reason="Former spouse"))
        elif member.relation in ("spouse", "partner"):
            if (
                statutory_relation
                and member.relation == statutory_relation
                and not spouse
            ):
                spouse = _Heir(member, display_name(member), "spouse", 0.0)
            else:
                excluded.append(
                    Excluded(
                        member_id=member.id,
                        reason="No statutory entitlement: not married to the client",
                    )
                )
    if statutory_relation and spouse is None:
        # Known to exist, not recorded: still an heir.
        spouse = _Heir(None, "Spouse (not recorded)", "spouse", 0.0)
        missing.append("The spouse's details")

    children = [
        _Heir(m, display_name(m), "child", 0.0)
        for m in family.members
        if m.relation == "child"
    ]
    if not children and family.has_children is None:
        missing.append("Whether the client has children")
    if not children and family.has_children:
        missing.append("The children's details")
        return [], excluded, missing, False

    if spouse and children:
        spouse.share = 0.5
        for child in children:
            child.share = 0.5 / len(children)
        heirs = [spouse, *children]
    elif children:
        for child in children:
            child.share = 1.0 / len(children)
        heirs = children
    else:
        # A spouse alone shares with the client's parents' line; no spouse and no
        # children goes to that line entirely. Neither is recorded here.
        return [], excluded, missing, False
    return heirs, excluded, missing, True


def simulate(
    dossier: Dossier, settings: Settings, rules: RuleSet | None = None
) -> Succession:
    """The estate, the taxes it would trigger and what each heir would receive."""
    rules = rules or load_rules()
    missing: list[str] = []

    # --- the estate, asset by asset, net of the debt secured on each asset ---
    secured: dict[str, float] = {}
    unsecured = 0.0
    for liability in dossier.liabilities:
        value = settings.to_base(liability.amount, liability.currency) or 0.0
        if liability.secured_by_asset_id:
            secured[liability.secured_by_asset_id] = (
                secured.get(liability.secured_by_asset_id, 0.0) + value
            )
        else:
            unsecured += value

    net_value: dict[str, float] = {}
    at_bank = liquid = gross_assets = 0.0
    for asset in dossier.assets:
        value = settings.to_base(asset.amount, asset.currency)
        if value is None:
            continue
        share = (
            asset.client_share_pct if asset.client_share_pct is not None else 100
        ) / 100
        value *= share
        gross_assets += value
        net_value[asset.id] = max(value - secured.get(asset.id, 0.0) * share, 0.0)
        bankable = (
            asset.bankable
            if asset.bankable is not None
            else DEFAULT_BANKABLE.get(asset.type)
        )
        if bankable and asset.type in LIQUID_TYPES:
            liquid += value
        if bankable and settings.is_house_bank(asset.bank):
            at_bank += value
    total_debt = unsecured + sum(
        secured.get(a.id, 0.0)
        * ((a.client_share_pct if a.client_share_pct is not None else 100) / 100)
        for a in dossier.assets
    )
    estate = max(gross_assets - total_debt, 0.0)

    if any(a.type in SECURITY_TYPES and not a.situs for a in dossier.assets):
        missing.append(
            "Where the securities are domiciled (taken as where they are booked)"
        )

    heirs, excluded, heir_missing, modelled = _heirs(dossier)
    missing += heir_missing
    if not modelled:
        # Still worth showing what the assets trigger: one notional heir, no allowance.
        heirs = [_Heir(None, "Heirs not determined", "other", 1.0)]
    if dossier.family.has_will is None:
        missing.append("Whether the client has a will or an inheritance contract")
    if (
        any(h.relation == "spouse" for h in heirs)
        and dossier.family.marital_regime is None
    ):
        missing.append("The matrimonial property regime")

    # --- taxes ---
    taxes: list[Tax] = []
    situs_tax = {id(h): 0.0 for h in heirs}

    def add(
        rule: Rule, heir: _Heir | None, assets: list[Asset], base: float, high: float
    ):
        taxes.append(
            Tax(
                rule_id=rule.id,
                layer=rule.layer,
                topic=rule.topic,
                country=rule.country,
                asset_ids=[a.id for a in assets],
                heir_id=heir.id if heir else None,
                base=base,
                low=high * rule.low_factor,
                high=high,
                expert=rule.expert,
                source=rule.source,
            )
        )

    for rule in rules.rules:
        if rule.layer != "situs":
            continue
        assets = [a for a in dossier.assets if a.id in net_value and _matches(rule, a)]
        base = sum(net_value[a.id] for a in assets)
        if base <= 0:
            continue
        if rule.per == "heir":
            for heir in heirs:
                amount = _tax(rule, base * heir.share, heir.relation, settings)
                if amount:
                    add(rule, heir, assets, base * heir.share, amount)
                    situs_tax[id(heir)] += amount
        else:
            # One tax on the part going to heirs who are not exempt, then shared between them.
            liable = [
                h
                for h in heirs
                if rule.allowance.get(h.relation, rule.allowance.get("any", 0))
                != "exempt"
            ]
            liable_share = sum(h.share for h in liable)
            amount = (
                _tax(rule, base * liable_share, "any", settings) if liable else None
            )
            if amount:
                add(rule, None, assets, base * liable_share, amount)
                for heir in liable:
                    situs_tax[id(heir)] += amount * heir.share / liable_share

    heir_tax = dict(situs_tax)
    for rule in rules.rules:
        if rule.layer != "heir":
            continue
        for heir in heirs:
            if heir.country != rule.when.get("heir_residence"):
                continue
            gross = estate * heir.share
            amount = _tax(rule, gross, heir.relation, settings)
            # The heir's country taxes everything received; what the assets already
            # trigger is counted once, so only the excess is added.
            extra = (amount or 0.0) - situs_tax[id(heir)]
            if extra > 0:
                add(rule, heir, [], gross, extra)
                heir_tax[id(heir)] += extra

    cost_high = sum(t.high for t in taxes)
    cost_low = sum(t.low for t in taxes)
    return Succession(
        rules_version=rules.version,
        illustrative=rules.illustrative,
        assumptions=rules.assumptions,
        missing_inputs=missing,
        experts=rules.experts,
        heirs_modelled=modelled,
        estate=estate,
        cost_low=cost_low,
        cost_high=cost_high,
        net_to_heirs=estate - cost_high,
        liquid_assets=liquid,
        liquidity_gap=max(cost_high - liquid, 0.0),
        taxes=taxes,
        heirs=[
            Heir(
                member_id=h.id,
                label=h.label,
                relation=h.relation,
                country=h.country,
                share_pct=h.share * 100,
                gross=estate * h.share,
                tax=heir_tax[id(h)],
                net=estate * h.share - heir_tax[id(h)],
                aum_at_bank=at_bank * h.share,
            )
            for h in heirs
            if modelled
        ],
        excluded=excluded,
    )
