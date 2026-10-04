"""The guided review and the listening mode, with the voice model in the loop."""

import textwrap

import pytest
from conftest import load
from livekit.plugins import google
from test_agent import session_for

from prompts import after_button, step_brief
from stages import FamilyAgent, speak_unprompted
from store import PrepStore

pytestmark = pytest.mark.asyncio


def step_titled(store: PrepStore, title: str):
    return next(s for s in store.state.agenda if s.title == title)


def past_briefing(store: PrepStore) -> None:
    store.finish_step("answered")


async def test_briefing_ends_when_the_banker_agrees_to_start() -> None:
    store = load("c-008")
    async with session_for(store, mode="guided") as session:
        result = await session.run(user_input="Yes, let's start.")
        result.expect.contains_function_call(name="finish_step")

    assert step_titled(store, "Briefing").status == "done"
    assert store.state.current_step_id == store.state.agenda[1].id


async def test_an_answer_is_recorded_and_the_review_moves_on(blank: PrepStore) -> None:
    past_briefing(blank)
    blank.go_to_step(step_titled(blank, "Marital status").id)
    async with session_for(blank, mode="guided") as session:
        await session.run(user_input="He is single.")

    marital = step_titled(blank, "Marital status")
    assert blank.state.family.marital_status == "single"
    assert (marital.status, marital.outcome) == ("done", "answered")
    assert blank.state.current_step_id != marital.id


async def test_not_knowing_keeps_the_point_for_the_meeting() -> None:
    store = load("c-004")
    past_briefing(store)
    art = step_titled(store, "Scandinavian art collection")
    store.go_to_step(art.id)
    async with session_for(store, mode="guided") as session:
        await session.run(user_input="No idea what it's worth. I'll ask him.")

    art = step_titled(store, "Scandinavian art collection")
    assert (art.status, art.outcome) == ("done", "for_meeting")
    assert set(art.point_ids) <= {p.id for p in store.open_points()}


async def test_not_relevant_dismisses_the_point() -> None:
    store = load("c-002")
    past_briefing(store)
    contact = step_titled(store, "Last contact")
    store.go_to_step(contact.id)
    async with session_for(store, mode="guided") as session:
        await session.run(user_input="That's not relevant, skip it.")

    contact = step_titled(store, "Last contact")
    assert (contact.status, contact.outcome) == ("done", "dismissed")
    assert not set(contact.point_ids) & {p.id for p in store.open_points()}


async def test_family_comes_up_only_once_the_banker_agrees() -> None:
    store = load("c-003")
    past_briefing(store)
    last_wealth = [
        s for s in store.state.agenda if s.group == "wealth" and s.kind == "point"
    ][-1]
    while store.state.current_step_id != last_wealth.id:
        store.finish_step("for_meeting")
    async with (
        session_for(store, mode="guided") as session,
        google.LLM(model="gemini-flash-latest") as judge,
    ):
        result = await session.run(user_input="I don't know. I'll ask her.")
        # The wealth part is closed, the question is asked, and the screen has not moved.
        assert store.current_step.id == "enter-family"
        assert store.state.stage == "wealth"
        await (
            result.expect[-1]
            .is_message(role="assistant")
            .judge(
                judge,
                intent="Says the wealth part is finished and asks whether to move on to the family. Does not ask a question about the family itself yet.",
            )
        )

        result = await session.run(user_input="Yes, go ahead.")
        result.expect.contains_agent_handoff(new_agent_type=FamilyAgent)
        assert isinstance(session.current_agent, FamilyAgent)

    assert store.state.stage == "family"
    assert store.current_step.group == "family"


async def test_pausing_and_carrying_on_resumes_at_the_same_step() -> None:
    store = load("c-008")
    past_briefing(store)
    position = store.state.current_step_id
    async with session_for(store, mode="guided") as session:
        await session.run(
            user_input="Hold on, let me look at this on my own for a moment."
        )
        assert store.state.mode == "listening"
        assert store.state.current_step_id == position

        await session.run(user_input="OK, carry on with the review.")

    assert store.state.mode == "guided"
    assert store.state.current_step_id == position


async def test_listening_mode_records_without_leading() -> None:
    store = load("c-005")
    async with (
        session_for(store, mode="listening") as session,
        google.LLM(model="gemini-flash-latest") as judge,
    ):
        result = await session.run(
            user_input="Her crypto holdings are worth five hundred thousand dollars now."
        )
        await result.expect.contains_message(role="assistant").judge(
            judge,
            intent=textwrap.dedent(
                """\
                Confirms the change in a few words. Does not ask the banker for other
                information and does not bring up other gaps or meeting points. A short
                offer of further help is acceptable.
                """
            ),
        )

    crypto = next(a for a in store.state.assets if a.id == "ast-4")
    assert crypto.amount == 500_000


def go_to(store: PrepStore, step_id: str) -> None:
    """Take the review to a step, closing what comes before it."""
    while store.current_step.id != step_id:
        store.finish_step("for_meeting")


async def test_accepting_the_offer_runs_the_simulation() -> None:
    store = load("c-008")
    go_to(store, "simulation-offer")
    assert store.state.scenario is None
    async with session_for(store, mode="guided") as session:
        await session.run(user_input="Yes, show me.")

    assert store.current_step.id == "simulation-wealth"
    assert store.state.scenario == "death"


async def test_declining_the_offer_skips_the_simulation() -> None:
    store = load("c-008")
    go_to(store, "simulation-offer")
    async with session_for(store, mode="guided") as session:
        await session.run(user_input="No, not today. Let's skip that.")

    assert store.state.scenario is None
    # The report is then asked for, not jumped to.
    assert store.current_step.id == "enter-report"
    assert store.state.stage == "family"
    assert all(
        s.status == "done" for s in store.state.agenda if s.group == "simulation"
    )


async def test_what_a_note_says_is_recorded_once_the_banker_confirms() -> None:
    store = load("c-001")
    past_briefing(store)
    store.go_to_step("step:item:note-1:wealth")
    count = len(store.state.assets)
    async with session_for(store, mode="guided") as session:
        await session.run(
            user_input="Yes, that's still right. Record it: four million francs in a discretionary mandate, funds, at Julius Baer in Switzerland."
        )

    assert len(store.state.assets) == count + 1
    added = store.state.assets[-1]
    assert added.amount == 4_000_000 and "baer" in (added.bank or "").lower()
    assert "note.c-001-ext" not in {p.rule_key for p in store.open_points()}
    note_step = next(s for s in store.state.agenda if s.id == "step:item:note-1:wealth")
    assert (note_step.status, note_step.outcome) == ("done", "answered")


async def test_each_reply_is_about_the_step_on_screen() -> None:
    """Walks part of a review and checks, turn by turn, that the voice follows the screen."""
    store = load("c-003")
    past_briefing(store)
    async with (
        session_for(store, mode="guided") as session,
        google.LLM(model="gemini-flash-latest") as judge,
    ):
        for _ in range(6):
            before = store.current_step
            answer = (
                "Yes, go ahead."
                if before.kind == "gate"
                else "I don't know. I'll ask her."
            )
            result = await session.run(user_input=answer)
            step = store.current_step
            assert step.id != before.id, "the review did not move on"
            if step.kind == "gate":
                intent = "Says that one part of the review is finished and asks whether to move on to the next part. Asks nothing else about the client."
            else:
                intent = (
                    f"Asks or talks about this subject: {step.title} ({step.say}). "
                    "Does not bring up any other open question about the client. "
                    "A few words acknowledging the previous answer, or saying which part of the review this is, are fine."
                )
            # The last thing said in the turn: after a change of stage it is the agent
            # taking over that speaks.
            await (
                result.expect[-1]
                .is_message(role="assistant")
                .judge(judge, intent=intent)
            )


async def test_a_point_the_banker_dictates_is_noted_and_not_asked_again() -> None:
    store = load("c-008")
    past_briefing(store)
    position = store.state.current_step_id
    async with session_for(store, mode="guided") as session:
        result = await session.run(
            user_input="Before I forget, note this for the meeting: the children should be invited to the next meeting."
        )
        result.expect.contains_function_call(name="add_meeting_point")

    [point] = [p for p in store.state.meeting_points if p.source != "rule"]
    assert "children" in point.text.lower()
    noted = next(s for s in store.state.agenda if point.id in s.point_ids)
    assert (noted.status, noted.outcome) == ("done", "for_meeting")
    # The review is still where it was: the note did not become a question of its own.
    assert store.state.current_step_id == position


async def test_report_is_not_reached_while_points_remain() -> None:
    store = load("c-008")
    past_briefing(store)
    position = store.state.current_step_id
    async with (
        session_for(store, mode="guided") as session,
        google.LLM(model="gemini-flash-latest") as judge,
    ):
        result = await session.run(user_input="Let's stop here and go to the report.")
        await (
            result.expect[-1]
            .is_message(role="assistant")
            .judge(
                judge,
                intent="Says that points remain to be reviewed and asks whether to keep them for the meeting. Does not say the report is ready or on screen.",
            )
        )
        assert store.state.current_step_id == position
        assert store.state.stage == "wealth"

        await session.run(user_input="Yes, keep them all for the meeting.")

    assert store.current_step.id == "enter-report"
    assert not store.remaining()


async def test_speaks_french_when_asked_to() -> None:
    store = load("c-008")
    store.set_language("fr")
    async with (
        session_for(store, mode="guided") as session,
        google.LLM(model="gemini-flash-latest") as judge,
    ):
        result = await session.run(user_input="Oui, on peut commencer.")
        await (
            result.expect[-1]
            .is_message(role="assistant")
            .judge(judge, intent="Is written in French, not in English.")
        )

    assert store.state.agenda[0].status == "done"


async def test_a_step_closed_with_a_button_is_not_recorded_by_warren() -> None:
    """The banker presses "Ask the client" on a note: Warren moves on and records nothing."""
    store = load("c-008")
    past_briefing(store)
    note = store.current_step
    assert note.title.startswith("Activity note")
    assets = len(store.state.assets)
    async with session_for(store, mode="guided") as session:
        await speak_unprompted(session, session.userdata, step_brief(store))
        for _ in range(3):
            closed = store.current_step
            store.finish_step("for_meeting")
            await speak_unprompted(
                session, session.userdata, after_button(store, closed, "for_meeting")
            )

    assert len(store.state.assets) == assets
    assert [p for p in store.state.meeting_points if p.source != "rule"] == []
