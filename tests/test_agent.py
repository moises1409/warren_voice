"""Behaviour of the stage agents, run in-process against the production voice model.

These tests call the model, so they need GOOGLE_API_KEY (from .env.local) and
are slower than the rest of the suite. Assertions are on what ends up in the
store: that is what the banker sees on screen.
"""

import textwrap
from contextlib import asynccontextmanager

import pytest
from conftest import load, open_keys
from livekit.agents import AgentSession
from livekit.plugins import google

from agent import build_llm
from stages import FamilyAgent, Prep, WealthAgent, make_agent
from store import PrepStore

pytestmark = pytest.mark.asyncio


@asynccontextmanager
async def session_for(store: PrepStore, stage: str = "wealth", mode: str = "listening"):
    """A conversation on `store`. Listening mode on a given stage unless a guided review is asked for,
    which starts on whatever step the store is on."""
    store.set_mode(mode)
    if mode == "listening":
        store.set_stage(stage)
    prep = Prep(store=store)
    async with AgentSession[Prep](
        llm=build_llm(store.state.language), userdata=prep
    ) as session:
        await session.start(make_agent(store.state.stage, prep, first=True))
        yield session


async def test_records_an_asset_with_all_its_details(blank: PrepStore) -> None:
    async with session_for(blank) as session:
        result = await session.run(
            user_input="He has two million euros in equities at UBS in Switzerland."
        )
        result.expect.contains_function_call(name="record_asset")

    [asset] = blank.state.assets
    assert (asset.type, asset.amount, asset.currency) == ("equities", 2_000_000, "EUR")
    assert asset.country == "CH"
    assert asset.bankable is True
    assert "ubs" in (asset.bank or "").lower()


async def test_assumes_francs_and_knows_the_house_bank(blank: PrepStore) -> None:
    async with session_for(blank) as session:
        await session.run(user_input="He keeps five hundred thousand in cash with us.")

    [asset] = blank.state.assets
    assert (asset.type, asset.amount, asset.currency) == ("cash", 500_000, "CHF")
    assert blank.settings.is_house_bank(asset.bank)


async def test_partial_fact_is_recorded_and_becomes_a_point(blank: PrepStore) -> None:
    async with session_for(blank) as session:
        await session.run(
            user_input="He owns a holiday home in Spain. I have no idea what it is worth."
        )

    [asset] = blank.state.assets
    assert (asset.type, asset.country, asset.amount) == ("real_estate", "ES", None)
    assert f"asset.incomplete:{asset.id}" in open_keys(blank)


async def test_correction_updates_instead_of_duplicating() -> None:
    store = load("c-001")
    count = len(store.state.assets)
    async with session_for(store) as session:
        await session.run(
            user_input="Correction: the Mallorca apartment is worth two million euros, not one point six."
        )

    assert len(store.state.assets) == count
    mallorca = next(a for a in store.state.assets if a.id == "ast-7")
    assert (mallorca.amount, mallorca.currency) == (2_000_000, "EUR")


async def test_records_income_with_a_future_date(blank: PrepStore) -> None:
    async with session_for(blank) as session:
        await session.run(
            user_input="He expects an inheritance of one million francs in June 2027."
        )

    [flow] = blank.state.cash_flows
    assert (flow.direction, flow.type, flow.frequency) == (
        "income",
        "inheritance",
        "one_off",
    )
    assert flow.amount == 1_000_000
    assert flow.date is not None and (flow.date.year, flow.date.month) == (2027, 6)


async def test_notes_a_point_the_banker_asks_for() -> None:
    store = load("c-001")
    async with session_for(store) as session:
        result = await session.run(
            user_input="Note for the meeting: ask her about the succession plan for the company."
        )
        result.expect.contains_function_call(name="add_meeting_point")

    added = [p for p in store.state.meeting_points if p.source == "agent"]
    assert len(added) == 1
    assert "succession" in added[0].text.lower()


async def test_moving_on_hands_over_to_the_family_stage(blank: PrepStore) -> None:
    async with session_for(blank) as session:
        result = await session.run(
            user_input="That's all on wealth. Let's move on to the family."
        )
        result.expect.contains_agent_handoff(new_agent_type=FamilyAgent)
        assert isinstance(session.current_agent, FamilyAgent)

        await session.run(user_input="Actually, go back to the wealth part.")
        assert isinstance(session.current_agent, WealthAgent)

    assert blank.state.stage == "wealth"


async def test_records_the_family(blank: PrepStore) -> None:
    async with session_for(blank, "family") as session:
        await session.run(
            user_input="He is married to Karin, who is 44. They have one daughter, Lina, aged 6. They all live in Bern."
        )

    family = blank.state.family
    assert family.marital_status == "married"
    by_relation = {m.relation: m for m in family.members}
    assert set(by_relation) == {"spouse", "child"}
    assert by_relation["spouse"].name == "Karin"
    assert by_relation["spouse"].birth_year == 1982
    assert by_relation["child"].name == "Lina"
    assert by_relation["child"].birth_year == 2020
    assert by_relation["child"].residence.country == "CH"
    assert family.has_children is True


async def test_no_children_is_recorded_explicitly(blank: PrepStore) -> None:
    async with session_for(blank, "family") as session:
        await session.run(user_input="He is single and has no children.")

    assert blank.state.family.marital_status == "single"
    assert blank.state.family.has_children is False
    assert not {k for k in open_keys(blank) if k.startswith("family.")}


async def test_does_not_give_investment_advice() -> None:
    store = load("c-003")
    async with (
        session_for(store) as session,
        google.LLM(model="gemini-flash-latest") as judge,
    ):
        result = await session.run(
            user_input="She has too much cash. Which funds should I tell her to buy?"
        )
        await result.expect.contains_message(role="assistant").judge(
            judge,
            intent=textwrap.dedent(
                """\
                Does not name or recommend any fund, product, allocation or transaction.
                Declines, or redirects to preparing a question or topic for the client meeting.
                """
            ),
        )


async def test_new_asset_on_a_client_with_existing_data() -> None:
    store = load("c-003")
    count = len(store.state.assets)
    async with session_for(store) as session:
        result = await session.run(
            user_input="She owns an apartment in Geneva worth one point five million francs."
        )
        result.expect.contains_function_call(name="record_asset")

    assert len(store.state.assets) == count + 1
    apartment = store.state.assets[-1]
    assert (apartment.type, apartment.amount) == ("real_estate", 1_500_000)


async def test_new_income_does_not_overwrite_an_existing_one() -> None:
    store = load("c-003")
    before = {f.id: f.model_dump() for f in store.state.cash_flows}
    async with session_for(store) as session:
        await session.run(
            user_input="She also earns fifty thousand francs a year teaching at the university."
        )

    after = {f.id: f.model_dump() for f in store.state.cash_flows}
    assert {k: after[k] for k in before} == before
    [new] = [f for i, f in after.items() if i not in before]
    assert (new["direction"], new["amount"]) == ("income", 50_000)


async def test_does_not_invent_identifiers() -> None:
    store = load("c-003")
    async with session_for(store, "family") as session:
        await session.run(user_input="Her partner is called Luca. He is 47.")

    [partner] = store.state.family.members
    assert (partner.relation, partner.name, partner.birth_year) == (
        "partner",
        "Luca",
        1979,
    )
    assert "family.partner.unknown" not in open_keys(store)
