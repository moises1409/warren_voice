"""Deterministic checks on a dossier.

Each check yields findings: gaps, inconsistencies and implausible facts that
must reach the banker whether or not the voice model notices them. The store
turns findings into meeting points and closes them when the data fixes them.

Softer, judgement-based guidance lives in `knowledge/*.md` and is applied by
the agent.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Iterator
from dataclasses import dataclass

from fx import Settings
from models import Dossier, PointKind, Section, country_name, display_name
from succession import Succession, Tax, simulate
from summary import compute_totals

# A note's amount counts as recorded when the positions reach this share of it.
NOTE_AMOUNT_TOLERANCE = 0.80
# A single non-bankable asset above this share of total assets is raised as a topic.
CONCENTRATION_THRESHOLD = 0.50
CONCENTRATION_MIN_ASSETS = 3
STALE_CONTACT_DAYS = 180
RETIREMENT_AGE = 65
MIN_PARENT_AGE = 14


@dataclass(frozen=True)
class Finding:
    # Stable identity: the same problem always produces the same key.
    key: str
    section: Section
    kind: PointKind
    text: str
    related_item_id: str | None = None
    # For a cost of inaction: the bank expert to involve and the amount at stake.
    expert: str | None = None
    amount: float | None = None


def age_on(born: dt.date, today: dt.date) -> int:
    return today.year - born.year - ((today.month, today.day) < (born.month, born.day))


def _join(parts: list[str]) -> str:
    if len(parts) <= 1:
        return "".join(parts)
    return ", ".join(parts[:-1]) + " and " + parts[-1]


def _incomplete(
    prefix: str, section: Section, item, missing: list[str]
) -> Iterator[Finding]:
    if missing:
        yield Finding(
            key=f"{prefix}.incomplete:{item.id}",
            section=section,
            kind="missing",
            text=f"{display_name(item)}: {_join(missing)} not known.",
            related_item_id=item.id,
        )


def _wealth_items(d: Dossier) -> Iterator[Finding]:
    for asset in d.assets:
        missing = []
        if asset.amount is None:
            missing.append("value")
        if not asset.currency:
            missing.append("currency")
        if not asset.country:
            missing.append("country")
        if asset.bankable is None:
            missing.append("whether it is held at a bank")
        elif asset.bankable and not asset.bank:
            missing.append("custodian bank")
        yield from _incomplete("asset", "wealth", asset, missing)

    for liability in d.liabilities:
        missing = []
        if liability.amount is None:
            missing.append("amount")
        if not liability.currency:
            missing.append("currency")
        if not liability.bank:
            missing.append("lender")
        if not liability.country:
            missing.append("country")
        yield from _incomplete("liability", "wealth", liability, missing)

    for pension in d.pensions:
        missing = []
        if pension.amount is None:
            missing.append("value")
        if not pension.currency:
            missing.append("currency")
        yield from _incomplete("pension", "wealth", pension, missing)

    for flow in d.cash_flows:
        missing = []
        if flow.amount is None:
            missing.append("amount")
        if not flow.currency:
            missing.append("currency")
        if flow.frequency is None:
            missing.append("whether it is recurring or one-off")
        elif flow.frequency == "one_off" and flow.date is None:
            missing.append("date")
        yield from _incomplete("cashflow", "wealth", flow, missing)


def _wealth_overall(
    d: Dossier, settings: Settings, today: dt.date
) -> Iterator[Finding]:
    totals = compute_totals(d, settings)
    fmt = settings.format
    client_age = age_on(d.client.date_of_birth, today)

    # Mortgages need a property on the asset side.
    has_real_estate = any(a.type == "real_estate" for a in d.assets)
    if not has_real_estate:
        for liability in d.liabilities:
            if liability.type == "mortgage":
                yield Finding(
                    f"wealth.mortgage.no_property:{liability.id}",
                    "wealth",
                    "inconsistency",
                    f"{display_name(liability)} is recorded, but no real estate appears among the assets.",
                    liability.id,
                )

    # Recurring income and expenses.
    recurring = [f for f in d.cash_flows if f.frequency != "one_off"]
    has_income = any(f.direction == "income" for f in recurring)
    has_expenses = any(f.direction == "expense" for f in recurring)
    if not has_income:
        yield Finding(
            "wealth.income.none", "wealth", "missing", "No recurring income recorded."
        )
    if not has_expenses:
        yield Finding(
            "wealth.expenses.none",
            "wealth",
            "missing",
            "No recurring expenses recorded.",
        )
    if (
        has_income
        and has_expenses
        and totals.recurring_expenses > totals.recurring_income
    ):
        gap = totals.recurring_expenses - totals.recurring_income
        yield Finding(
            "wealth.cashflow.deficit",
            "wealth",
            "plausibility",
            f"Recurring expenses ({fmt(totals.recurring_expenses)} a year) exceed recurring income ({fmt(totals.recurring_income)}): how is the gap of {fmt(gap)} funded?",
        )

    # One-off inflows still to come.
    for flow in d.cash_flows:
        if (
            flow.direction == "income"
            and flow.frequency == "one_off"
            and flow.date is not None
            and flow.date >= today
        ):
            amount = settings.to_base(flow.amount, flow.currency)
            what = f" of {fmt(amount)}" if amount is not None else ""
            yield Finding(
                f"wealth.inflow.upcoming:{flow.id}",
                "wealth",
                "topic",
                f"{display_name(flow)}{what} is expected on {flow.date:%d %B %Y}: what are the client's plans for it?",
                flow.id,
            )

    # Pension provision before retirement.
    if not d.pensions and client_age < RETIREMENT_AGE:
        yield Finding(
            "wealth.pension.none",
            "wealth",
            "missing",
            f"No pension plan recorded (the client is {client_age}).",
        )

    # Concentration in a single illiquid asset. A diversified portfolio at a bank
    # is one line here but not one risk, so bankable assets are left out.
    valued = [
        (a, v)
        for a in d.assets
        if not a.bankable and (v := settings.to_base(a.amount, a.currency)) is not None
    ]
    if valued and len(d.assets) >= CONCENTRATION_MIN_ASSETS and totals.assets > 0:
        asset, top = max(valued, key=lambda pair: pair[1])
        share = top / totals.assets
        if share > CONCENTRATION_THRESHOLD:
            yield Finding(
                f"wealth.concentration:{asset.id}",
                "wealth",
                "topic",
                f"{display_name(asset)} represents {share:.0%} of total assets.",
                asset.id,
            )


def _family(d: Dossier, today: dt.date) -> Iterator[Finding]:
    family = d.family
    members = family.members
    client_birth_year = d.client.date_of_birth.year
    home = d.client.domicile.country

    if family.marital_status is None:
        yield Finding(
            "family.marital_status.unknown",
            "family",
            "missing",
            "Marital status not known.",
        )

    partner_relation = {
        "married": "spouse",
        "registered_partnership": "partner",
        "cohabiting": "partner",
    }.get(family.marital_status or "")
    if partner_relation and not any(
        m.relation in ("spouse", "partner") for m in members
    ):
        yield Finding(
            "family.partner.unknown",
            "family",
            "missing",
            f"The client is {family.marital_status.replace('_', ' ')}, but nothing is known about the {partner_relation}.",
        )

    children = [m for m in members if m.relation == "child"]
    if family.has_children is None and not children:
        yield Finding(
            "family.children.unknown",
            "family",
            "missing",
            "Not known whether the client has children.",
        )
    elif family.has_children and not children:
        yield Finding(
            "family.children.undetailed",
            "family",
            "missing",
            "The client has children, but no details are recorded.",
        )

    for member in members:
        if member.relation not in ("spouse", "partner", "child"):
            continue
        missing = []
        if not member.name:
            missing.append("name")
        if member.birth_year is None:
            missing.append("age")
        if member.residence is None or not member.residence.country:
            missing.append("country of residence")
        yield from _incomplete("family", "family", member, missing)

        country = member.residence.country if member.residence else None
        if country and home and country != home:
            yield Finding(
                f"family.abroad:{member.id}",
                "family",
                "topic",
                f"{display_name(member)} lives in {country_name(country)}, outside the client's country of domicile.",
                member.id,
            )

        if (
            member.relation == "child"
            and member.birth_year is not None
            and member.birth_year - client_birth_year < MIN_PARENT_AGE
        ):
            yield Finding(
                f"family.child.age:{member.id}",
                "family",
                "plausibility",
                f"{display_name(member)} would have been born when the client was {member.birth_year - client_birth_year}: please verify the year of birth.",
                member.id,
            )


def _general(d: Dossier, today: dt.date) -> Iterator[Finding]:
    last = d.client.last_contact
    if last is None:
        yield Finding(
            "general.contact.unknown", "general", "missing", "No last contact recorded."
        )
    elif (today - last).days > STALE_CONTACT_DAYS:
        months = (today - last).days // 30
        yield Finding(
            "general.contact.stale",
            "general",
            "topic",
            f"Last contact was {months} months ago ({last:%d %B %Y}).",
        )


def _reflected(d: Dossier, settings: Settings, expect: dict) -> bool:
    """Whether the structured data contains what a note says."""
    kind = expect.get("kind")
    name = (expect.get("name") or "").casefold()

    def named(member) -> bool:
        return not name or name in (member.name or "").casefold()

    if kind == "external_assets":
        bank = (expect.get("bank") or "").casefold()
        held = sum(
            settings.to_base(a.amount, a.currency) or 0.0
            for a in d.assets
            if a.bank
            and not settings.is_house_bank(a.bank)
            and (not bank or bank in a.bank.casefold())
        )
        target = settings.to_base(expect.get("amount"), expect.get("currency")) or 0.0
        return held > 0 and held >= target * NOTE_AMOUNT_TOLERANCE
    if kind == "asset":
        label = (expect.get("label_contains") or "").casefold()
        return any(
            (not expect.get("asset_type") or a.type == expect["asset_type"])
            and (not label or label in (a.label or "").casefold())
            for a in d.assets
        )
    if kind == "liability":
        return any(x.type == expect.get("liability_type") for x in d.liabilities)
    if kind == "cash_flow":
        return any(
            f.direction == expect.get("direction") and f.type == expect.get("flow_type")
            for f in d.cash_flows
        )
    if kind == "family_member":
        return any(
            m.relation == expect.get("relation") and named(m) for m in d.family.members
        )
    if kind == "member_residence":
        return any(
            named(m) and m.residence and m.residence.country == expect.get("country")
            for m in d.family.members
        )
    if kind == "marital_status":
        return d.family.marital_status == expect.get("value")
    if kind == "will":
        return d.family.has_will is not None
    return True


def _notes(d: Dossier, settings: Settings) -> Iterator[Finding]:
    """What activity notes say that the structured fields of the CRM do not carry."""
    for note in d.activity_notes:
        for fact in note.facts:
            if not _reflected(d, settings, fact.expect):
                yield Finding(
                    f"note.{fact.id}",
                    fact.section,
                    "inconsistency",
                    f"Activity note of {note.date:%d %B %Y}: it mentions {fact.summary}. This is not in the structured fields of the CRM.",
                    # Facts from the same note are discussed together.
                    note.id,
                )


def _succession(d: Dossier, s: Succession, settings: Settings) -> Iterator[Finding]:
    """Costs of inaction and open questions from the death-of-the-client simulation."""
    fmt = settings.format
    names = {a.id: display_name(a) for a in d.assets}
    members = {m.id: m for m in d.family.members}

    situs: dict[str, list[Tax]] = {}
    for tax in s.taxes:
        if tax.layer == "situs":
            situs.setdefault(tax.rule_id, []).append(tax)
        elif tax.heir_id in members:
            heir = display_name(members[tax.heir_id])
            yield Finding(
                f"succession.{tax.rule_id}:{tax.heir_id}",
                "family",
                "inefficiency",
                f"{heir} lives in {country_name(tax.country)}, which taxes what its residents inherit: up to {fmt(tax.high)} more than the assets alone would trigger.",
                tax.heir_id,
                expert=tax.expert,
                amount=tax.high,
            )
    for rule_id, taxes in situs.items():
        first = taxes[0]
        total = sum(t.high for t in taxes)
        assets = _join([names[i] for i in first.asset_ids if i in names])
        yield Finding(
            f"succession.{rule_id}",
            "wealth",
            "inefficiency",
            f"{first.topic}: on the client's death, {assets} could cost the heirs up to {fmt(total)} in tax in {country_name(first.country)}.",
            first.asset_ids[0] if first.asset_ids else None,
            expert=first.expert,
            amount=total,
        )

    if s.liquidity_gap > 0:
        yield Finding(
            "succession.liquidity",
            "wealth",
            "inefficiency",
            f"Estimated taxes on death (up to {fmt(s.cost_high)}) exceed the liquid assets ({fmt(s.liquid_assets)}): the heirs might have to sell or borrow.",
            expert="tax_succession",
            amount=s.liquidity_gap,
        )

    for excluded in s.excluded:
        member = members.get(excluded.member_id)
        if member and member.relation == "partner":
            yield Finding(
                f"succession.excluded:{member.id}",
                "family",
                "topic",
                f"{display_name(member)} has no statutory entitlement to the estate as an unmarried partner: has the client made arrangements?",
                member.id,
                expert="tax_succession",
            )

    if d.family.has_will is None:
        yield Finding(
            "succession.will.unknown",
            "family",
            "missing",
            "Not known whether the client has a will or an inheritance contract.",
        )
    if any(h.relation == "spouse" for h in s.heirs) and d.family.marital_regime is None:
        yield Finding(
            "succession.regime.unknown",
            "family",
            "missing",
            "Matrimonial property regime not known.",
        )
    if (
        not s.heirs_modelled
        and d.family.marital_status is not None
        and d.family.has_children is False
        and s.estate > 0
    ):
        yield Finding(
            "succession.heirs.undetermined",
            "family",
            "topic",
            "No children and no spouse to inherit everything: who does the client want the estate to go to?",
            expert="tax_succession",
        )


def run_checks(
    dossier: Dossier,
    settings: Settings,
    today: dt.date | None = None,
    succession: Succession | None = None,
) -> list[Finding]:
    today = today or dt.date.today()
    succession = succession or simulate(dossier, settings)
    return [
        *_notes(dossier, settings),
        *_succession(dossier, succession, settings),
        *_wealth_items(dossier),
        *_wealth_overall(dossier, settings, today),
        *_family(dossier, today),
        *_general(dossier, today),
    ]
