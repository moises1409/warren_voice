"""The three stage agents and their tools.

Each stage has its own agent so the model only carries the instructions,
guidance and tools of the stage in progress. All of them work on the same
`PrepStore`, held in the session's userdata.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from livekit.agents import Agent, RunContext, ToolError, function_tool
from pydantic import ValidationError

from models import (
    AssetType,
    CashFlowType,
    Direction,
    Frequency,
    Holding,
    LiabilityType,
    MaritalRegime,
    MaritalStatus,
    Mode,
    PensionType,
    PointKind,
    PointStatus,
    Relation,
    Section,
    Stage,
    StepOutcome,
)
from prompts import KNOWLEDGE_DIR, build_instructions, step_brief, succession_state
from report import Narrator, generate_report, narrate_with_gemini
from store import ItemNotFoundError, PrepStore

logger = logging.getLogger("agent")


@dataclass
class Prep:
    """Session userdata."""

    store: PrepStore
    knowledge_dir: Path = KNOWLEDGE_DIR
    narrator: Narrator = narrate_with_gemini
    report_task: asyncio.Task | None = field(default=None, repr=False)
    # The turn in which the review last moved on. One turn moves it one step at most.
    advanced_in: str | None = field(default=None, repr=False)
    # The speech Warren makes of its own, as when the banker used a button: nobody said
    # anything, so nothing may be recorded in it.
    unprompted: str | None = field(default=None, repr=False)
    # Cleared while one stage agent hands over to the next.
    stage_ready: asyncio.Event = field(default_factory=asyncio.Event, repr=False)

    def start_report(self) -> asyncio.Task:
        """Generate the report in the background; the screen updates when it is ready."""
        if self.report_task and not self.report_task.done():
            self.report_task.cancel()
        self.report_task = asyncio.create_task(
            generate_report(self.store, self.narrator, self.knowledge_dir)
        )
        return self.report_task


Ctx = RunContext[Prep]


def _changes(store: PrepStore, before: set[str]) -> str:
    """What a mutation did to the open meeting points, for the tool result."""
    after = {p.id: p for p in store.open_points()}
    opened = [p for i, p in after.items() if i not in before]
    closed = len(before - set(after))
    parts = []
    if closed:
        parts.append(f"{closed} open point(s) closed.")
    for point in opened:
        parts.append(f"New point {point.id}: {point.text}")
    return " ".join(parts)


def _route(context: Ctx, text: str, then: Callable[[], str] | None = None):
    """A tool result, with a handoff when the review moved to another stage or mode.

    The agent in charge carries the instructions and tools of one stage and one mode;
    when the store has moved on, the matching agent takes over and speaks first.
    """
    prep = context.userdata
    agent = context.session.current_agent
    state = prep.store.state
    if getattr(agent, "stage", state.stage) != state.stage or (
        getattr(agent, "mode", state.mode) != state.mode
    ):
        # The agent taking over presents the step itself when it enters.
        return make_agent(state.stage, prep), text
    return f"{text} {then()}".strip() if then else text


def speak_unprompted(session, prep: Prep, instructions: str):
    """Have Warren speak without the banker having said anything: at the start, after a button,
    on taking over a stage. Nothing can be recorded in that speech, since nothing was answered.
    """
    handle = session.generate_reply(instructions=instructions)
    prep.unprompted = handle.id
    return handle


def _hands_off(context: Ctx) -> None:
    if context.speech_handle.id == context.userdata.unprompted:
        raise ToolError(
            "Nothing was done: the banker has not answered yet. Do not say you recorded anything. Ask about the current step and wait for the answer."
        )


def _apply(context: Ctx, action, describe):
    """Run a store mutation and turn the outcome into a result the model can act on."""
    _hands_off(context)
    store = context.userdata.store
    before = {p.id for p in store.open_points()}
    step_before = store.state.current_step_id
    try:
        item = action(store)
    except ItemNotFoundError as e:
        raise ToolError(
            f"There is no item with identifier {e}. Use an identifier from the recorded data, or omit it to create a new item."
        ) from None
    except ValidationError as e:
        problems = "; ".join(
            f"{'.'.join(str(p) for p in err['loc'])}: {err['msg']}"
            for err in e.errors()
        )
        raise ToolError(f"Not saved, invalid value. {problems}") from None
    text = f"{describe(item)} {_changes(store, before)}".strip()
    if store.state.mode == "guided" and store.state.current_step_id != step_before:
        # The answer closed the step: say what comes next so the review keeps moving.
        context.userdata.advanced_in = context.speech_handle.id
        return _route(context, text + " That step is done.", lambda: step_brief(store))
    return _route(context, text)


def _need(value: Any, what: str) -> None:
    if value is None:
        raise ToolError(f"{what} is required when recording a new item.")


# --- tools shared by all stages ---------------------------------------------


@function_tool
async def add_meeting_point(
    context: Ctx, text: str, section: Section, kind: PointKind = "topic"
) -> str:
    """Add a point the banker should raise or ask in the client meeting.

    Use it for something worth raising that is not already among the open points,
    or when the banker asks you to note something for the meeting.

    Args:
        text: The point, worded as a question or a topic to explore with the client.
        section: What the point is about: wealth, family, or general.
        kind: missing (information to obtain), inconsistency, plausibility (a fact to verify), or topic.
    """
    guided = context.userdata.store.state.mode == "guided"
    return _apply(
        context,
        lambda s: s.add_meeting_point(text, section, kind),
        lambda p: (
            f"Added point {p.id}. It is kept for the meeting and will be in the report: do not raise it again. "
            "Ask one question about it only if it is unclear, then return to the current step."
            if guided
            else f"Added point {p.id}."
        ),
    )


@function_tool
async def update_meeting_point(
    context: Ctx,
    point_id: str,
    status: PointStatus | None = None,
    text: str | None = None,
) -> str:
    """Reword a meeting point, or close it.

    Args:
        point_id: Identifier of the point, for example mp-3.
        status: dismissed when the banker says the point is not relevant, resolved when it has been dealt with, open to reopen it.
        text: New wording, if the banker wants it changed.
    """
    return _apply(
        context,
        lambda s: s.update_meeting_point(point_id, text=text, status=status),
        lambda p: f"Point {p.id} is now {p.status}.",
    )


@function_tool
async def remove_item(context: Ctx, item_id: str) -> str:
    """Delete a recorded asset, liability, pension plan, income, expense or family member.

    Only when the banker says it does not exist or was recorded by mistake. To correct a value, record the item again with its identifier instead.

    Args:
        item_id: Identifier of the item, for example ast-2, lia-1, pen-1, cf-4 or fam-2.
    """
    return _apply(
        context, lambda s: s.remove_item(item_id), lambda _: f"Removed {item_id}."
    )


@function_tool
async def go_to_stage(context: Ctx, stage: Stage):
    """Move the session to another stage: wealth, family or report.

    Use it when the banker asks to move on or go back, or when the current stage is covered and the banker agrees to continue.

    Args:
        stage: The stage to move to.
    """
    prep = context.userdata
    prep.store.set_stage(stage)
    return make_agent(stage, prep), f"Moved to the {stage} stage."


@function_tool
async def finish_step(context: Ctx, outcome: StepOutcome):
    """Close the current step of the guided review and move to the next one.

    Args:
        outcome: for_meeting when the banker does not know and it stays as a point for the client meeting; dismissed when the banker says it is not relevant; answered for a briefing or a simulation step the banker has acknowledged.
    """
    prep = context.userdata
    store = prep.store
    _hands_off(context)
    turn = context.speech_handle.id
    if prep.advanced_in == turn:
        # The model sometimes closes the step it has just been given, in the same breath,
        # before the banker has heard it. The banker answers each step in a turn of their own.
        return (
            "The review already moved on in this turn; nothing was closed. "
            "Present the current step to the banker and wait for their answer."
        )
    prep.advanced_in = turn
    store.finish_step(outcome)
    return _route(context, "Step closed.", lambda: step_brief(store))


@function_tool
async def finish_remaining(context: Ctx):
    """Keep every step still to review for the client meeting and go to the end of the review.

    Only when the banker has asked to finish or to see the report early, and has agreed to leave the remaining points for the meeting.
    """
    store = context.userdata.store
    count = store.finish_remaining()
    return _route(
        context, f"{count} step(s) kept for the meeting.", lambda: step_brief(store)
    )


@function_tool
async def previous_step(context: Ctx):
    """Go back to the previous step of the guided review, when the banker asks to go back."""
    store = context.userdata.store
    store.previous_step()
    return _route(context, "Went back.", lambda: step_brief(store))


@function_tool
async def set_mode(context: Ctx, mode: Mode):
    """Change who leads the conversation.

    Args:
        mode: listening when the banker wants to look on their own ("let me look", "stop"); guided when the banker wants to be walked through ("guide me", "carry on").
    """
    store = context.userdata.store
    store.set_mode(mode)
    if mode == "listening":
        return _route(context, "The banker leads now.")
    return _route(context, "You lead again.", lambda: step_brief(store))


@function_tool
async def show_simulation(context: Ctx, on: bool) -> str:
    """Show on screen what would happen if the client died today, or go back to today's picture.

    The simulation shows the taxes the estate would trigger, how much would reach the heirs, and who would receive what.
    Use it when the banker asks what happens on the client's death, about inheritance or succession, or about the cost of leaving things as they are.

    Args:
        on: True to show the simulation, False to go back to today's picture.
    """
    store = context.userdata.store
    store.set_scenario("death" if on else None)
    if not on:
        return "Back to today's picture."
    return "The simulation is on screen. " + succession_state(store)


COMMON_TOOLS = [
    add_meeting_point,
    update_meeting_point,
    remove_item,
    show_simulation,
    set_mode,
]
GUIDED_TOOLS = [*COMMON_TOOLS, finish_step, previous_step, finish_remaining]
LISTENING_TOOLS = [*COMMON_TOOLS, go_to_stage]


# --- stage agents ------------------------------------------------------------


class StageAgent(Agent):
    stage: Stage
    entry: str

    def __init__(self, prep: Prep, first: bool = False) -> None:
        super().__init__(
            instructions=build_instructions(self.stage, prep.store, prep.knowledge_dir),
            # In a guided review the order belongs to the review: the model cannot
            # change stage on its own, only close the step it is on.
            tools=GUIDED_TOOLS
            if prep.store.state.mode == "guided"
            else LISTENING_TOOLS,
        )
        self._first = first
        self.mode: Mode = prep.store.state.mode

    async def on_enter(self) -> None:
        prep: Prep = self.session.userdata
        prep.stage_ready.set()
        if prep.store.state.stage != self.stage:
            prep.store.set_stage(self.stage)
        store = prep.store
        if self.mode == "listening":
            speech = (
                "Greet the banker in a few words, say which client this is, and say that you are listening: they can ask you to change anything on screen, or to guide them through it. Do not ask about the data."
                if self._first
                else "Say in a few words that you will stay quiet until asked."
            )
        else:
            resumed = any(step.status == "done" for step in store.state.agenda)
            if not self._first:
                opening = ""
            elif resumed:
                number, total = store.progress()
                opening = f"The banker is resuming a review started earlier. Welcome them back and say in one sentence that the review is at point {number} of {total}. "
            else:
                opening = "This is the start of the session. Greet the banker in a few words. "
            speech = opening + step_brief(store)
        # A stage agent stays silent after a handoff unless it is asked to speak.
        speak_unprompted(self.session, self.session.userdata, speech)


class WealthAgent(StageAgent):
    stage = "wealth"
    entry = (
        "Say the balance sheet is on screen, then ask about the most important gap in the wealth picture. "
        "If nothing is missing, ask whether anything has changed since the last contact."
    )

    @function_tool
    async def record_asset(
        self,
        context: Ctx,
        asset_id: str | None = None,
        asset_type: AssetType | None = None,
        amount: float | None = None,
        currency: str | None = None,
        country: str | None = None,
        bankable: bool | None = None,
        bank: str | None = None,
        label: str | None = None,
        situs: str | None = None,
        holding: Holding | None = None,
        client_share_pct: float | None = None,
    ) -> str:
        """Record a new asset, or update one already recorded.

        Pass only what the banker said; leave the rest out. To update, pass asset_id and the fields that change.

        Args:
            asset_id: Identifier of an asset already recorded, for example ast-2. Omit to record a new asset.
            asset_type: Required for a new asset.
            amount: Value in full units, for example 2400000 for 2.4 million.
            currency: Three-letter code. CHF if the banker gave none.
            country: Two-letter code of where the asset is located or booked.
            bankable: True if it is held in a bank custody account. Leave out for standard types.
            bank: Custodian bank, for bankable assets.
            label: Short description, for example "Holiday home, Mallorca".
            situs: Two-letter code of the country a share, bond or fund is domiciled in. Always pass it for securities when the banker names the company or the fund, or says where it is domiciled: Apple, Microsoft or any US company is US, a US-domiciled fund is US, an Irish or Luxembourg fund is IE or LU. It is not the country where the securities are booked.
            holding: direct for securities or property held in the client's own name, fund when held through an investment fund, company when held through a company.
            client_share_pct: The client's share in percent when the asset is co-owned, for example 50.
        """
        if asset_id is None:
            _need(asset_type, "asset_type")
        return _apply(
            context,
            lambda s: s.upsert_asset(
                asset_id,
                type=asset_type,
                amount=amount,
                currency=currency,
                country=country,
                bankable=bankable,
                bank=bank,
                label=label,
                situs=situs,
                holding=holding,
                client_share_pct=client_share_pct,
            ),
            lambda a: f"Saved asset {a.id}.",
        )

    @function_tool
    async def record_liability(
        self,
        context: Ctx,
        liability_id: str | None = None,
        liability_type: LiabilityType | None = None,
        amount: float | None = None,
        currency: str | None = None,
        bank: str | None = None,
        country: str | None = None,
        secured_by_asset_id: str | None = None,
        label: str | None = None,
    ) -> str:
        """Record a new debt (mortgage, loan, tax owed), or update one already recorded.

        Args:
            liability_id: Identifier of a liability already recorded, for example lia-1. Omit to record a new one.
            liability_type: Required for a new liability.
            amount: Outstanding amount in full units.
            currency: Three-letter code. CHF if the banker gave none.
            bank: The lender.
            country: Two-letter code of the lender's country.
            secured_by_asset_id: For a mortgage, the identifier of the property it finances.
            label: Short description.
        """
        if liability_id is None:
            _need(liability_type, "liability_type")
        return _apply(
            context,
            lambda s: s.upsert_liability(
                liability_id,
                type=liability_type,
                amount=amount,
                currency=currency,
                bank=bank,
                country=country,
                secured_by_asset_id=secured_by_asset_id,
                label=label,
            ),
            lambda x: f"Saved liability {x.id}.",
        )

    @function_tool
    async def record_pension(
        self,
        context: Ctx,
        pension_id: str | None = None,
        pension_type: PensionType | None = None,
        provider: str | None = None,
        amount: float | None = None,
        currency: str | None = None,
        country: str | None = None,
    ) -> str:
        """Record a new pension plan, or update one already recorded.

        Args:
            pension_id: Identifier of a plan already recorded, for example pen-1. Omit to record a new one.
            pension_type: Required for a new plan. pillar_2 is the occupational pension, pillar_3a and pillar_3b private pensions.
            provider: Pension fund, insurer or bank.
            amount: Current value in full units.
            currency: Three-letter code. CHF if the banker gave none.
            country: Two-letter code.
        """
        if pension_id is None:
            _need(pension_type, "pension_type")
        return _apply(
            context,
            lambda s: s.upsert_pension(
                pension_id,
                type=pension_type,
                provider=provider,
                amount=amount,
                currency=currency,
                country=country,
            ),
            lambda p: f"Saved pension plan {p.id}.",
        )

    @function_tool
    async def record_cash_flow(
        self,
        context: Ctx,
        cash_flow_id: str | None = None,
        direction: Direction | None = None,
        flow_type: CashFlowType | None = None,
        frequency: Frequency | None = None,
        amount: float | None = None,
        currency: str | None = None,
        date: str | None = None,
        label: str | None = None,
    ) -> str:
        """Record a new income or expense, or update one already recorded.

        Args:
            cash_flow_id: Identifier of an entry already recorded, for example cf-3. Omit to record a new one.
            direction: income or expense. Required for a new entry.
            flow_type: Required for a new entry.
            frequency: recurring, or one_off for a single event such as a bonus, an inheritance, a gift or a purchase.
            amount: Per year when recurring, the full amount when one-off. Full units.
            currency: Three-letter code. CHF if the banker gave none.
            date: For a one-off entry, when it happens, as YYYY-MM-DD. Use the first of the month if only a month is known.
            label: Short description.
        """
        if cash_flow_id is None:
            _need(direction, "direction")
            _need(flow_type, "flow_type")
        parsed: dt.date | None = None
        if date:
            try:
                parsed = dt.date.fromisoformat(date)
            except ValueError:
                raise ToolError("date must be YYYY-MM-DD.") from None
        return _apply(
            context,
            lambda s: s.upsert_cash_flow(
                cash_flow_id,
                direction=direction,
                type=flow_type,
                frequency=frequency,
                amount=amount,
                currency=currency,
                date=parsed,
                label=label,
            ),
            lambda f: f"Saved {f.direction} {f.id}.",
        )


class FamilyAgent(StageAgent):
    stage = "family"
    entry = (
        "Say the family tree is on screen, then ask about the most important gap in the family picture. "
        "If nothing is missing, ask whether anything has changed in the family."
    )

    @function_tool
    async def set_family_status(
        self,
        context: Ctx,
        marital_status: MaritalStatus | None = None,
        has_children: bool | None = None,
        marital_regime: MaritalRegime | None = None,
        has_will: bool | None = None,
    ) -> str:
        """Record the client's marital status, whether there are children, the matrimonial property regime, and whether there is a will.

        Args:
            marital_status: The client's current status.
            has_children: False when the banker says the client has no children. Recording a child sets it to true by itself.
            marital_regime: The matrimonial property regime of a married client. participation_in_acquisitions is the Swiss default when the couple made no contract.
            has_will: Whether the client has a will or an inheritance contract.
        """
        if (
            marital_status is None
            and has_children is None
            and marital_regime is None
            and has_will is None
        ):
            raise ToolError("Pass at least one of the fields.")

        def action(store: PrepStore):
            store.set_family(
                marital_status=marital_status,
                has_children=has_children,
                marital_regime=marital_regime,
                has_will=has_will,
            )
            return store.state.family

        return _apply(context, action, lambda _: "Saved.")

    @function_tool
    async def record_family_member(
        self,
        context: Ctx,
        member_id: str | None = None,
        relation: Relation | None = None,
        name: str | None = None,
        age: int | None = None,
        birth_year: int | None = None,
        city: str | None = None,
        country: str | None = None,
        other_parent_id: str | None = None,
        notes: str | None = None,
    ) -> str:
        """Record a new family member, or update one already recorded.

        Record each child separately.

        Args:
            member_id: Identifier of a member already recorded, for example fam-2. Omit to record a new one.
            relation: Relation to the client. Required for a new member.
            name: First name, or full name if given.
            age: Age in years, if the banker gave an age.
            birth_year: Year of birth, if the banker gave a year.
            city: City of residence.
            country: Two-letter code of the country of residence. Always pass it when the city is known (Bern is CH).
            other_parent_id: For a child, the identifier of the spouse, partner or former spouse who is the other parent.
            notes: Anything else the banker wants noted about this person.
        """
        if member_id is None:
            _need(relation, "relation")

        def action(store: PrepStore):
            fields: dict[str, Any] = {
                "relation": relation,
                "name": name,
                "birth_year": birth_year
                if birth_year is not None
                else (store.today.year - age if age is not None else None),
                "other_parent_id": other_parent_id,
                "notes": notes,
            }
            if city or country:
                current = None
                if member_id:
                    current = next(
                        (
                            m.residence
                            for m in store.state.family.members
                            if m.id == member_id
                        ),
                        None,
                    )
                fields["residence"] = {
                    "city": city or (current.city if current else None),
                    "country": (
                        country or (current.country if current else None) or ""
                    ).upper()
                    or None,
                }
            return store.upsert_family_member(member_id, **fields)

        return _apply(context, action, lambda m: f"Saved family member {m.id}.")


class ReportAgent(StageAgent):
    stage = "report"
    entry = "Say the report is being prepared on screen, and ask whether the banker wants to add or drop any meeting point."

    async def on_enter(self) -> None:
        prep: Prep = self.session.userdata
        prep.start_report()
        await super().on_enter()
        step = prep.store.current_step
        if self.mode == "guided" and step and step.kind == "closing":
            # Reaching the report is the end of the review; nothing is left to ask.
            prep.store.finish_step("answered")

    @function_tool
    async def regenerate_report(self, context: Ctx) -> str:
        """Rebuild the report on screen after the meeting points or the data changed."""
        context.userdata.start_report()
        return "The report is being regenerated and will refresh on screen."


AGENTS: dict[str, type[StageAgent]] = {
    "wealth": WealthAgent,
    "family": FamilyAgent,
    "report": ReportAgent,
}


def make_agent(stage: Stage, prep: Prep, first: bool = False) -> StageAgent:
    return AGENTS[stage](prep, first=first)
