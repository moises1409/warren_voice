"""The guided review as a list of steps, derived from the meeting points.

A pure function of the session state: rebuilt after every change, like the
checks. Steps keep their identity across rebuilds, so what the banker already
went through stays done, in this conversation or in a later one.

Order: briefing; wealth; family; general; then the offer to simulate the
client's death, and if accepted its effect on the wealth and on the family;
then the report.
"""

from __future__ import annotations

import datetime as dt

from checks import age_on
from fx import Settings
from models import MeetingPoint, PrepState, Step, display_name
from summary import compute_totals

# Within a group: what does not add up first, then what is missing, then topics.
KIND_ORDER = {"inconsistency": 0, "plausibility": 1, "missing": 2, "topic": 3}

# Titles for points that are about the client as a whole, by the check that raised them.
TITLES = {
    "wealth.cashflow.deficit": "Expenses above income",
    "wealth.income.none": "Recurring income",
    "wealth.expenses.none": "Recurring expenses",
    "wealth.pension.none": "Pension plans",
    "family.marital_status": "Marital status",
    "family.partner": "Spouse or partner",
    "family.children": "Children",
    "succession.will": "Will or inheritance contract",
    "succession.regime": "Matrimonial property regime",
    "succession.liquidity": "Liquidity on death",
    "succession.heirs": "Heirs",
    "general.contact": "Last contact",
}


def _focus(point: MeetingPoint) -> str | None:
    """The part of the wealth view a point is about, which stays open while it is discussed."""
    item = point.related_item_id or ""
    key = point.rule_key or ""
    if item.startswith("cf-") or key.startswith(
        ("wealth.income", "wealth.expenses", "wealth.cashflow", "wealth.inflow")
    ):
        return "cashflow"
    if item.startswith("pen-") or key.startswith(("wealth.pension", "pension.")):
        return "pensions"
    return "balance" if point.section == "wealth" else None


def _targets(points: list[MeetingPoint], state: PrepState) -> list[str]:
    """Everything on screen a group of points is about, in the order it should be lit."""
    ids: list[str] = []
    taxes = (state.succession or {}).get("taxes", [])
    for point in points:
        key = point.rule_key or ""
        if point.related_item_id:
            ids.append(point.related_item_id)
        if key == "wealth.cashflow.deficit":
            ids += [f.id for f in state.cash_flows if f.frequency != "one_off"]
        if point.kind == "inefficiency" and key.startswith("succession."):
            # Every asset the rule taxes, not only the first.
            rule = key.removeprefix("succession.").split(":")[0]
            ids += [i for t in taxes if t["ruleId"] == rule for i in t["assetIds"]]
    return list(dict.fromkeys(ids))


def _title(points: list[MeetingPoint], names: dict[str, str]) -> str:
    key = points[0].rule_key or ""
    for prefix, title in TITLES.items():
        if key.startswith(prefix):
            return title
    if points[0].kind == "inefficiency" and points[0].section == "wealth":
        # The rule's own name: "French real estate held directly by a non-resident".
        return points[0].text.split(":")[0]
    item = points[0].related_item_id
    if item and item in names:
        return names[item]
    # "Activity note of 12 May 2026: ...", "French real estate held directly ...: ..."
    text = points[0].text
    head = text.split(":")[0]
    return head if len(head) <= 60 else text[:57].rstrip() + "..."


def _point_steps(
    points: list[MeetingPoint],
    group: str,
    stage: str,
    scenario: str | None,
    names: dict[str, str],
    state: PrepState,
) -> list[Step]:
    """One step per subject: points about the same item, or from the same note, go together."""
    groups: dict[str, list[MeetingPoint]] = {}
    for point in points:
        item = point.related_item_id
        if not item:
            key = f"point:{point.id}"
        elif item.startswith("note-"):
            # A note can say things about the wealth and about the family.
            key = f"item:{item}:{group}"
        else:
            key = f"item:{item}"
        groups.setdefault(key, []).append(point)

    def rank(members: list[MeetingPoint]) -> tuple:
        if scenario:
            # Costs of inaction: the largest first.
            return (-max(p.amount or 0.0 for p in members),)
        return (min(KIND_ORDER.get(p.kind, 9) for p in members),)

    steps = []
    for key, members in sorted(groups.items(), key=lambda kv: rank(kv[1])):
        still_open = [p for p in members if p.status == "open"]
        # What the banker asked to note is not a question to come back to: it is
        # recorded when said and goes straight to the report.
        noted = all(p.source != "rule" for p in members)
        shown = still_open or members
        dismissed = all(p.status == "dismissed" for p in members)
        steps.append(
            Step(
                # A cost of inaction about an item is a different subject from a gap in it.
                id=f"{'cost' if scenario else 'step'}:{key}",
                kind="point",
                group=group,
                stage=stage,
                scenario=scenario,
                focus=_focus(members[0]),
                title=_title(shown, names),
                say=" ".join(p.text for p in shown),
                point_ids=[p.id for p in members],
                item_id=members[0].related_item_id,
                target_ids=_targets(shown, state),
                origin="banker" if noted else "rule",
                status="pending" if still_open and not noted else "done",
                outcome=(
                    "for_meeting"
                    if still_open and noted
                    else None
                    if still_open
                    else ("dismissed" if dismissed else "answered")
                ),
            )
        )
    return steps


def _recap(steps: list[Step], group: str) -> str:
    points = [s for s in steps if s.group == group and s.kind == "point"]
    kept = sum(s.outcome == "for_meeting" or s.status == "pending" for s in points)
    dropped = sum(s.outcome == "dismissed" for s in points)
    plural = "point" if kept == 1 else "points"
    return f"{kept} {plural} kept for the meeting" + (
        f", {dropped} dismissed" if dropped else ""
    )


def build_agenda(
    state: PrepState, settings: Settings, today: dt.date, previous: list[Step]
) -> list[Step]:
    fmt = settings.format
    client = state.client
    totals = compute_totals(state, settings)
    succession = state.succession or {}
    names = {
        item.id: display_name(item)
        for item in [
            *state.assets,
            *state.liabilities,
            *state.pensions,
            *state.cash_flows,
            *state.family.members,
        ]
    }

    def of(section: str, costs: bool) -> list[MeetingPoint]:
        return [
            p
            for p in state.meeting_points
            if p.section == section and (p.kind == "inefficiency") == costs
        ]

    to_review = [
        p for p in state.meeting_points if p.status == "open" and p.source == "rule"
    ]
    costs = sum(p.kind == "inefficiency" for p in to_review)
    count = {
        section: sum(
            p.section == section and p.kind != "inefficiency" for p in to_review
        )
        for section in ("wealth", "family", "general")
    }

    steps: list[Step] = [
        Step(
            id="briefing",
            kind="briefing",
            group="briefing",
            stage="wealth",
            title="Briefing",
            say=(
                f"{client.name}, {age_on(client.date_of_birth, today)}, {client.segment}. "
                f"Net worth {fmt(totals.net_worth)}, of which {fmt(totals.aum_bank)} with us. "
                f"{len(to_review) - costs} points to go through: {count['wealth']} on wealth, "
                f"{count['family']} on the family"
                + (f", {count['general']} general" if count["general"] else "")
                + ". Then, if you wish, a simulation of what would happen on the client's death."
            ),
        )
    ]
    steps += _point_steps(of("wealth", False), "wealth", "wealth", None, names, state)

    family = _point_steps(of("family", False), "family", "family", None, names, state)
    if family:
        # Asked on the wealth screen: the family tree comes up once the banker agrees.
        steps.append(
            Step(
                id="enter-family",
                kind="gate",
                group="wealth",
                stage="wealth",
                title="Move on to the family?",
                say="",
            )
        )
        steps += family
    # General points have nothing of their own to show: they stay on the screen in place.
    steps += _point_steps(
        of("general", False),
        "general",
        "family" if family else "wealth",
        None,
        names,
        state,
    )

    if succession:
        cost = succession["costHigh"]
        steps.append(
            Step(
                id="simulation-offer",
                kind="offer",
                group="simulation",
                # Asked on the screen in place: the simulation comes up once the banker agrees.
                stage=steps[-1].stage,
                title="Simulate the client's death?",
                say=(
                    "See what would happen if the client died today: the taxes the estate "
                    "would trigger, how much the wealth would shrink, and who would receive what."
                ),
            )
        )
        steps.append(
            Step(
                id="simulation-wealth",
                kind="simulation",
                group="simulation",
                stage="wealth",
                scenario="death",
                focus="balance",
                title="Effect on the wealth",
                # The assets that trigger a tax.
                target_ids=list(
                    dict.fromkeys(i for t in succession["taxes"] for i in t["assetIds"])
                ),
                say=(
                    f"Estate {fmt(succession['estate'])}; taxes on death up to {fmt(cost)}; "
                    f"{fmt(succession['netToHeirs'])} would reach the heirs."
                    if cost > 0
                    else f"Estate {fmt(succession['estate'])}. The rules find no tax on death for the recorded assets and heirs."
                ),
            )
        )
        steps += _point_steps(
            of("wealth", True), "simulation", "wealth", "death", names, state
        )
        if succession["heirsModelled"]:
            home = client.domicile.country
            heirs = succession["heirs"]
            abroad = sum(
                h["aumAtBank"]
                for h in heirs
                if h["country"] and home and h["country"] != home
            )
            split = ", ".join(f"{h['label']} {h['sharePct']:.0f}%" for h in heirs)
            steps.append(
                Step(
                    id="simulation-family",
                    kind="simulation",
                    group="simulation",
                    stage="family",
                    scenario="death",
                    title="Who would receive what",
                    target_ids=[h["memberId"] for h in heirs if h["memberId"]],
                    say=(
                        f"Statutory split: {split}. Of the {fmt(totals.aum_bank)} held with us, "
                        f"{fmt(abroad)} would pass to heirs living abroad."
                    ),
                )
            )
        steps += _point_steps(
            of("family", True), "simulation", "family", "death", names, state
        )

    # The report is asked for on whatever the review ended on, and comes up once agreed.
    steps.append(
        Step(
            id="enter-report",
            kind="gate",
            group="report",
            stage=steps[-1].stage,
            scenario=steps[-1].scenario,
            title="Prepare the report?",
            say="",
        )
    )
    steps.append(
        Step(
            id="closing",
            kind="closing",
            group="report",
            stage="report",
            title="Report",
            say="",
        )
    )

    # What the banker already went through stays done, whatever the points did since.
    done = {s.id: s for s in previous if s.status == "done"}
    for step in steps:
        if step.id in done and step.status == "pending":
            step.status, step.outcome = "done", done[step.id].outcome

    # The gates and the closing step sum up what was decided, so they are worded last.
    points = [s for s in steps if s.kind == "point"]
    to_raise = sum(s.outcome == "for_meeting" or s.status == "pending" for s in points)
    # The report is asked for on the screen the review ended on: the simulation if it
    # was run, otherwise the last thing shown before it was offered.
    gate = next(s for s in steps if s.id == "enter-report")
    offer = next((s for s in steps if s.id == "simulation-offer"), None)
    ran = offer is not None and (
        offer.status == "pending" or offer.outcome == "answered"
    )
    before = [s for s in steps[: steps.index(gate)] if ran or s.group != "simulation"]
    gate.stage, gate.scenario = before[-1].stage, before[-1].scenario

    for step in steps:
        if step.id == "enter-family":
            step.say = f"That completes the wealth: {_recap(steps, 'wealth')}. Next comes the family."
        elif step.id == "enter-report":
            step.say = f"Everything has been gone through: {to_raise} points to raise in the meeting. Shall I prepare the report?"
        elif step.id == "closing":
            step.say = f"Review complete: {to_raise} points to raise in the meeting. The report is on screen."
    return steps


def next_pending(steps: list[Step], after: str | None) -> str | None:
    """The step to move to: the first one still to do after `after`, else the first overall.

    The report comes last whatever happens: while anything else is still to do, the
    review goes there, even when it lies before `after` (a point opened by an answer).
    """
    ids = [s.id for s in steps]
    start = ids.index(after) + 1 if after in ids else 0
    order = [*steps[start:], *steps[:start]]
    for step in [s for s in order if s.group != "report"] + [
        s for s in steps if s.group == "report"
    ]:
        if step.status == "pending":
            return step.id
    return None
