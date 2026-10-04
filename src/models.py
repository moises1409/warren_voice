"""Domain models for a meeting-preparation session.

JSON uses camelCase (shared with the frontend); Python uses snake_case.
Almost every field is optional: partial knowledge is stored, and `checks.py`
turns the gaps into meeting points.
"""

from __future__ import annotations

import datetime as dt
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

Segment = Literal["Entrepreneur", "Independent", "Privatier", "Top Executive"]
RiskScore = Literal["High", "Medium", "Low"]

AssetType = Literal[
    "cash",
    "equities",
    "bonds",
    "funds",
    "structured_products",
    "private_equity",
    "real_estate",
    "business_stake",
    "precious_metals",
    "crypto",
    "art_collectibles",
    "insurance",
    "other",
]
LiabilityType = Literal[
    "mortgage",
    "personal_loan",
    "lombard_loan",
    "business_loan",
    "tax_liability",
    "other",
]
PensionType = Literal["pillar_2", "pillar_3a", "pillar_3b", "foreign_pension", "other"]
Direction = Literal["income", "expense"]
Frequency = Literal["recurring", "one_off"]
CashFlowType = Literal[
    "salary",
    "bonus",
    "dividend",
    "rental",
    "pension",
    "business_income",
    "inheritance",
    "gift",
    "asset_sale",
    "living_costs",
    "housing",
    "taxes",
    "education",
    "debt_service",
    "alimony",
    "insurance",
    "major_purchase",
    "donation",
    "other",
]
MaritalStatus = Literal[
    "single",
    "married",
    "registered_partnership",
    "cohabiting",
    "separated",
    "divorced",
    "widowed",
]
Relation = Literal[
    "spouse",
    "partner",
    "ex_spouse",
    "child",
    "grandchild",
    "parent",
    "sibling",
    "other",
]
Stage = Literal["wealth", "family", "report"]
Section = Literal["wealth", "family", "general"]
# "inefficiency" is a cost of inaction: something in the structure that costs money if left as is.
PointKind = Literal["missing", "inconsistency", "plausibility", "topic", "inefficiency"]
Holding = Literal["direct", "company", "fund"]
MaritalRegime = Literal[
    "participation_in_acquisitions", "separation_of_property", "community_of_property"
]
Scenario = Literal["death"]
# Who leads the conversation: Warren, point by point, or the banker.
Mode = Literal["guided", "listening"]
# "offer" proposes the simulation; the banker may decline it.
# "gate" closes a part of the review and asks before moving to the next.
StepKind = Literal["briefing", "point", "gate", "offer", "simulation", "closing"]
# The language Warren speaks and the report is written in.
Language = Literal["en", "fr", "es"]
# "skipped": not gone through, because the simulation was declined.
StepOutcome = Literal["answered", "for_meeting", "dismissed", "skipped"]
# How the steps are grouped on screen.
StepGroup = Literal["briefing", "wealth", "family", "general", "simulation", "report"]
PointSource = Literal["rule", "agent", "banker"]
PointStatus = Literal["open", "resolved", "dismissed"]

# Whether an asset type is normally held in a bank custody account. Types left
# out (crypto, precious metals, insurance, other) can be either.
DEFAULT_BANKABLE: dict[str, bool] = {
    "cash": True,
    "equities": True,
    "bonds": True,
    "funds": True,
    "structured_products": True,
    "private_equity": False,
    "real_estate": False,
    "business_stake": False,
    "art_collectibles": False,
}

COUNTRY_NAMES: dict[str, str] = {
    "AT": "Austria",
    "CH": "Switzerland",
    "DE": "Germany",
    "ES": "Spain",
    "FR": "France",
    "GB": "the United Kingdom",
    "IT": "Italy",
    "LI": "Liechtenstein",
    "LU": "Luxembourg",
    "SE": "Sweden",
    "US": "the United States",
}


def country_name(code: str | None) -> str:
    if not code:
        return "an unknown country"
    return COUNTRY_NAMES.get(code.upper(), code.upper())


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid"
    )


class Place(CamelModel):
    city: str | None = None
    country: str | None = None  # ISO 3166-1 alpha-2


class Client(CamelModel):
    id: str
    name: str
    date_of_birth: dt.date
    domicile: Place
    segment: Segment
    risk_score: RiskScore
    performance_ytd_pct: float
    last_contact: dt.date | None = None


class Asset(CamelModel):
    id: str
    type: AssetType
    bankable: bool | None = None
    label: str | None = None
    amount: float | None = None
    currency: str | None = None  # ISO 4217
    country: str | None = None
    bank: str | None = None
    # The country whose tax law attaches to the asset: where a property stands, where an
    # instrument is domiciled. Distinct from `country`, where the asset is booked.
    situs: str | None = None
    holding: Holding | None = None
    # Share owned by the client, in percent; the whole asset when not given.
    client_share_pct: float | None = None


class Liability(CamelModel):
    id: str
    type: LiabilityType
    label: str | None = None
    amount: float | None = None
    currency: str | None = None
    country: str | None = None
    bank: str | None = None
    secured_by_asset_id: str | None = None


class Pension(CamelModel):
    id: str
    type: PensionType
    provider: str | None = None
    amount: float | None = None
    currency: str | None = None
    country: str | None = None


class CashFlow(CamelModel):
    id: str
    direction: Direction
    frequency: Frequency | None = None
    type: CashFlowType
    label: str | None = None
    amount: float | None = None  # per year when recurring
    currency: str | None = None
    date: dt.date | None = None  # one-off flows only


class FamilyMember(CamelModel):
    id: str
    relation: Relation
    name: str | None = None
    birth_year: int | None = None
    residence: Place | None = None
    # For children: the family member who is the other parent, if known.
    other_parent_id: str | None = None
    notes: str | None = None


class Family(CamelModel):
    marital_status: MaritalStatus | None = None
    has_children: bool | None = None
    marital_regime: MaritalRegime | None = None
    has_will: bool | None = None
    members: list[FamilyMember] = []


class MeetingPoint(CamelModel):
    id: str
    section: Section
    kind: PointKind
    text: str
    source: PointSource
    status: PointStatus = "open"
    related_item_id: str | None = None
    # Set for points created by a deterministic check; identifies the finding.
    rule_key: str | None = None
    # For a cost of inaction: the bank expert to involve and the amount at stake, in base currency.
    expert: str | None = None
    amount: float | None = None


class Step(CamelModel):
    """One step of the guided review."""

    id: str
    kind: StepKind
    group: StepGroup
    # What the screen shows during the step.
    stage: Stage
    scenario: Scenario | None = None
    # The part of the wealth view that stays open: balance, cashflow or pensions.
    focus: str | None = None
    title: str
    # What the step is about, as shown on its card.
    say: str
    point_ids: list[str] = []
    item_id: str | None = None
    # Everything on screen the step is about: lit, and scrolled to, while it lasts.
    target_ids: list[str] = []
    # "banker" for a point noted during the conversation: kept for the meeting at once.
    origin: Literal["rule", "banker"] = "rule"
    status: Literal["pending", "done"] = "pending"
    outcome: StepOutcome | None = None


class NoteFact(CamelModel):
    """Something an activity note says that belongs in a structured field of the CRM."""

    id: str
    section: Section
    # As it reads after "the note mentions".
    summary: str
    # What the structured data must contain for the fact to count as recorded.
    expect: dict[str, Any]


class ActivityNote(CamelModel):
    """A free-text note the banker wrote in the CRM after a contact with the client.

    Bankers often leave information here and forget to enter it in the structured
    fields, which is what the screen shows. `facts` is what the note contains;
    in this demo they are tagged by hand in the mock data.
    """

    id: str
    date: dt.date
    author: str | None = None
    text: str
    facts: list[NoteFact] = []


class Dossier(CamelModel):
    """What is known about a client. This is the shape stored in data/clients.json."""

    client: Client
    assets: list[Asset] = []
    liabilities: list[Liability] = []
    pensions: list[Pension] = []
    cash_flows: list[CashFlow] = []
    family: Family = Family()
    activity_notes: list[ActivityNote] = []


class PrepState(Dossier):
    """The full state of a preparation session, sent to the frontend as a snapshot."""

    rev: int = 0
    stage: Stage = "wealth"
    meeting_points: list[MeetingPoint] = []
    report: dict[str, Any] | None = None
    # What would happen on the client's death, recomputed after every change.
    succession: dict[str, Any] | None = None
    # The simulation shown on screen, if any. The figures exist either way.
    scenario: Scenario | None = None
    mode: Mode = "guided"
    language: Language = "en"
    agenda: list[Step] = []
    # The step the review is on; none once it is complete.
    current_step_id: str | None = None


def display_name(
    item: Asset | Liability | Pension | CashFlow | FamilyMember,
) -> str:
    """A short human name for an item, used in findings and tool results."""
    if isinstance(item, FamilyMember):
        return item.name or f"the client's {item.relation.replace('_', ' ')}"
    label = item.provider if isinstance(item, Pension) else item.label
    return label or item.type.replace("_", " ").capitalize()
