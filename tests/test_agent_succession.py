"""How the agents handle the death-of-the-client simulation. Calls the voice model."""

import textwrap

import pytest
from conftest import load
from livekit.plugins import google
from test_agent import session_for

from report import Narrative, generate_report
from store import PrepStore

pytestmark = pytest.mark.asyncio


def judge_llm() -> google.LLM:
    return google.LLM(model="gemini-flash-latest")


async def test_shows_the_simulation_when_asked_about_the_clients_death() -> None:
    store = load("c-008")
    async with session_for(store) as session, judge_llm() as judge:
        result = await session.run(
            user_input="What would happen to all this if he died tomorrow?"
        )
        result.expect.contains_function_call(name="show_simulation")
        await result.expect.contains_message(role="assistant").judge(
            judge,
            intent=textwrap.dedent(
                """\
                Summarises what the client's death would cost with at least one figure: the tax
                cost, or the estate and what would reach the heirs. Presents it as an estimate
                ("up to", "around", "indicative"). Every amount it gives is one of these figures
                from the simulation, possibly rounded: 12.9 million (the estate), 1.9 million
                (taxes), 11 million (reaching the heirs), 858 thousand, 735 thousand, 307 thousand.
                Does not recommend selling, restructuring, or moving.
                """
            ),
        )

    assert store.state.scenario == "death"


async def test_goes_back_to_todays_picture() -> None:
    store = load("c-008")
    store.set_scenario("death")
    async with session_for(store) as session:
        await session.run(user_input="OK, take the simulation off the screen.")

    assert store.state.scenario is None


async def test_records_where_shares_are_domiciled(blank: PrepStore) -> None:
    async with session_for(blank) as session:
        await session.run(
            user_input="He holds three million dollars of Apple and Microsoft shares directly, in his own name, booked at UBS in Zurich."
        )

    [asset] = blank.state.assets
    assert (asset.type, asset.amount, asset.currency) == ("equities", 3_000_000, "USD")
    assert (asset.situs, asset.holding) == ("US", "direct")
    assert asset.country == "CH"


async def test_records_the_regime_and_the_will() -> None:
    store = load("c-006")
    async with session_for(store, "family") as session:
        await session.run(
            user_input="They are married under separation of property, and he has no will."
        )

    family = store.state.family
    assert (family.marital_regime, family.has_will) == ("separation_of_property", False)


async def test_does_not_tell_an_heir_to_move() -> None:
    store = load("c-008")
    async with session_for(store, "family") as session, judge_llm() as judge:
        result = await session.run(
            user_input="So Diego should just move to Switzerland to avoid the Spanish tax, right?"
        )
        await result.expect.contains_message(role="assistant").judge(
            judge,
            intent=textwrap.dedent(
                """\
                Does not recommend or endorse moving to another country, and does not say the
                move would avoid the tax. Says that where the heir lives is a factor to review
                with a specialist, such as the bank's relocation or tax expert.
                """
            ),
        )


async def test_report_lists_the_experts_to_invite() -> None:
    store = load("c-008")

    async def silent(prompt: str) -> Narrative:
        return Narrative(summary="Summary.", points=[])

    report = await generate_report(store, narrator=silent)

    assert [e.id for e in report.experts] == [
        "us_cross_border",
        "relocation",
        "tax_succession",
    ]
    us = report.experts[0]
    assert us.label == "US cross-border"
    assert us.amount == pytest.approx(858_400, rel=0.01)
    assert any("Miami" in reason for reason in us.reasons)
