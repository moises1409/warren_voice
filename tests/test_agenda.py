"""The guided review: its steps, how it moves, and how it survives between conversations."""

from pathlib import Path

from conftest import TODAY, load

from prompts import build_instructions, step_brief
from report import build_prompt
from seed import seed
from sessions import SessionStore
from store import PrepStore


def ids(store: PrepStore) -> list[str]:
    return [s.id for s in store.state.agenda]


def step(store: PrepStore, step_id: str):
    return next(s for s in store.state.agenda if s.id == step_id)


def test_review_runs_from_briefing_to_report_with_the_simulation_after_the_points() -> (
    None
):
    store = load("c-008")
    order = ids(store)

    assert order[0] == "briefing" and order[-1] == "closing"
    assert store.state.current_step_id == "briefing"
    # Wealth, family and general points first; then the offer, and the simulation with its
    # costs, wealth before family.
    assert order.index("step:item:fam-2") < order.index("simulation-offer")
    assert (
        order.index("simulation-offer")
        < order.index("simulation-wealth")
        < order.index("cost:item:ast-3")
        < order.index("simulation-family")
        < order.index("cost:item:fam-2")
    )
    assert step(store, "cost:item:ast-3").scenario == "death"
    assert step(store, "closing").stage == "report"


def test_points_about_the_same_item_make_one_step() -> None:
    store = load("c-008")
    diego = step(store, "step:item:fam-2")

    # He lives abroad and his year of birth does not fit: one subject, one step.
    assert len(diego.point_ids) == 2
    assert diego.title == "Diego Ortega"
    # The cost his residence adds is a different subject, discussed with the simulation.
    assert step(store, "cost:item:fam-2").point_ids != diego.point_ids


def test_what_does_not_add_up_comes_before_what_is_missing() -> None:
    store = load("c-004")
    order = ids(store)

    # The note the CRM does not reflect comes before the art collection with no value.
    assert order.index("step:item:note-1:wealth") < order.index("step:item:ast-6")


def test_each_step_says_which_part_of_the_screen_it_is_about() -> None:
    store = load("c-004")

    assert step(store, "step:item:ast-6").focus == "balance"
    assert step(store, "step:item:cf-3").focus == "cashflow"
    assert step(store, "step:item:fam-2").stage == "family"


def test_finishing_a_step_moves_on_and_the_screen_follows() -> None:
    store = load("c-008")
    store.finish_step("answered")

    assert step(store, "briefing").status == "done"
    assert store.state.current_step_id == ids(store)[1]
    assert store.progress() == (2, len(ids(store)))

    # At the end of the wealth points the review asks before moving: the screen stays.
    while store.current_step.id != "enter-family":
        store.finish_step("for_meeting")
    assert store.state.stage == "wealth"
    assert store.current_step.say == (
        "That completes the wealth: 3 points kept for the meeting. Next comes the family."
    )
    store.finish_step("answered")
    assert store.state.stage == "family"

    # The simulation is offered on today's picture, and switches on once accepted.
    while store.current_step.id != "simulation-offer":
        store.finish_step("for_meeting")
    # Offered on the screen in place, here the family tree.
    assert (store.state.stage, store.state.scenario) == ("family", None)
    store.finish_step("answered")
    assert store.current_step.id == "simulation-wealth"
    assert (store.state.stage, store.state.scenario) == ("wealth", "death")


def test_an_answer_that_closes_the_point_finishes_the_step(blank: PrepStore) -> None:
    blank.finish_step("answered")  # the briefing
    blank.go_to_step(
        next(s.id for s in blank.state.agenda if s.title == "Marital status")
    )

    blank.set_family(marital_status="single")

    marital = next(s for s in blank.state.agenda if s.title == "Marital status")
    assert (marital.status, marital.outcome) == ("done", "answered")
    assert blank.state.current_step_id != marital.id


def test_for_the_meeting_keeps_the_point_and_dismissed_drops_it() -> None:
    store = load("c-008")
    store.finish_step("answered")
    first = store.current_step
    store.finish_step("for_meeting")
    second = store.current_step
    store.finish_step("dismissed")

    open_ids = {p.id for p in store.open_points()}
    assert set(first.point_ids) <= open_ids
    assert not set(second.point_ids) & open_ids
    assert [step(store, s.id).outcome for s in (first, second)] == [
        "for_meeting",
        "dismissed",
    ]


def test_going_back_reopens_the_previous_step() -> None:
    store = load("c-008")
    store.finish_step("answered")
    first = store.state.current_step_id
    store.finish_step("for_meeting")

    store.previous_step()

    assert store.state.current_step_id == first
    assert step(store, first).status == "pending"


def test_a_point_opened_by_an_answer_joins_the_review() -> None:
    store = load("c-001")
    before = len(ids(store))

    store.upsert_liability(type="mortgage", label="Second mortgage")

    assert len(ids(store)) == before + 1
    assert any(
        s.title == "Second mortgage" and s.status == "pending"
        for s in store.state.agenda
    )


def test_listening_mode_does_not_move_the_screen() -> None:
    store = load("c-008")
    store.set_mode("listening")
    store.set_stage("family")
    store.finish_step("answered")

    assert store.state.stage == "family"


def test_review_ends_after_the_closing_step() -> None:
    store = load("c-003")
    while store.current_step:
        store.finish_step("for_meeting")

    assert store.state.current_step_id is None
    assert all(s.status == "done" for s in store.state.agenda)
    assert store.state.stage == "report"


def test_session_resumes_where_it_was_left(tmp_path: Path) -> None:
    sessions = SessionStore(tmp_path)
    store = PrepStore.load("c-008", today=TODAY, sessions=sessions)
    store.finish_step("answered")
    store.finish_step("for_meeting")
    store.upsert_asset(
        type="cash", amount=1_000_000, currency="CHF", bank="UBS", country="CH"
    )
    position, assets = store.state.current_step_id, len(store.state.assets)

    resumed = PrepStore.load("c-008", today=TODAY, sessions=sessions)

    assert resumed.state.current_step_id == position
    assert len(resumed.state.assets) == assets
    assert step(resumed, "briefing").status == "done"
    assert resumed.progress() == store.progress()


def test_start_over_discards_the_saved_session(tmp_path: Path) -> None:
    sessions = SessionStore(tmp_path)
    store = PrepStore.load("c-008", today=TODAY, sessions=sessions)
    store.finish_step("answered")
    store.upsert_asset(type="cash", amount=1, currency="CHF", bank="UBS", country="CH")

    fresh = PrepStore.load("c-008", today=TODAY, sessions=sessions, reset=True)

    assert fresh.state.current_step_id == "briefing"
    assert len(fresh.state.assets) == 8


def test_seed_writes_new_sessions_and_leaves_work_in_progress(tmp_path: Path) -> None:
    sessions = SessionStore(tmp_path)
    assert len(seed(sessions=sessions)) == 8

    seeded = sessions.load("c-001")
    assert seeded.rev == 0
    assert seeded.meeting_points and seeded.succession and seeded.agenda

    store = PrepStore.load("c-001", today=TODAY, sessions=sessions)
    store.finish_step("answered")

    # Untouched sessions are refreshed; the one in progress is kept.
    assert "c-001" not in seed(sessions=sessions)
    assert sessions.load("c-001").current_step_id == store.state.current_step_id
    assert "c-001" in seed(force=True, sessions=sessions)
    assert sessions.load("c-001").current_step_id == "briefing"


def test_unreadable_session_falls_back_to_the_client_file(tmp_path: Path) -> None:
    (tmp_path / "c-001.json").write_text("{ not json", encoding="utf-8")

    store = PrepStore.load("c-001", today=TODAY, sessions=SessionStore(tmp_path))

    assert store.state.client.name == "Elena Brunner"
    assert store.state.current_step_id == "briefing"


def test_declining_the_simulation_skips_it_and_keeps_the_costs_for_the_report() -> None:
    store = load("c-008")
    costs = {p.id for p in store.open_points() if p.kind == "inefficiency"}
    while store.current_step.id != "simulation-offer":
        store.finish_step("for_meeting")

    store.finish_step("dismissed")

    assert store.current_step.id == "enter-report"
    assert store.state.scenario is None
    skipped = [s for s in store.state.agenda if s.group == "simulation"]
    assert {s.outcome for s in skipped} == {"dismissed", "skipped"}
    assert costs <= {p.id for p in store.open_points()}


def test_steps_are_grouped_for_the_screen() -> None:
    store = load("c-002")
    groups = [s.group for s in store.state.agenda]

    # Each group is one block: none appears again after another one started.
    blocks = [g for i, g in enumerate(groups) if i == 0 or groups[i - 1] != g]
    assert blocks == ["briefing", "wealth", "family", "general", "simulation", "report"]
    # The wealth block ends with the question that opens the family.
    assert [s.id for s in store.state.agenda if s.group == "wealth"][
        -1
    ] == "enter-family"


def test_a_note_about_wealth_and_family_makes_a_step_in_each() -> None:
    store = load("c-005")
    step_ids = ids(store)

    assert (
        "step:item:note-1:wealth" in step_ids and "step:item:note-1:family" in step_ids
    )
    assert len(step_ids) == len(set(step_ids))


def test_each_step_names_what_it_lights_up_on_screen() -> None:
    store = load("c-008")

    # A point about the client as a whole lights the items it is computed from.
    deficit = next(s for s in store.state.agenda if s.title == "Expenses above income")
    assert set(deficit.target_ids) == {"cf-1", "cf-2", "cf-4", "cf-5"}
    # A tax rule lights every asset it taxes, not only the first.
    assert step(store, "cost:item:ast-3").target_ids == ["ast-3", "ast-8"]
    assert step(store, "simulation-family").target_ids == ["fam-1", "fam-2", "fam-3"]
    assert step(store, "step:item:note-1:wealth").target_ids == ["note-1"]


def test_screen_changes_only_once_the_banker_agreed_at_a_gate() -> None:
    store = load("c-008")
    seen = []
    while store.current_step:
        current = store.current_step
        brief = step_brief(store)
        seen.append((current.id, store.state.stage, "you are now on" in brief))
        store.finish_step("answered" if current.kind != "point" else "for_meeting")

    by_id = {step_id: (stage, lead) for step_id, stage, lead in seen}
    # The gates are asked on the screen in place.
    assert by_id["enter-family"] == ("wealth", False)
    assert by_id["simulation-offer"][0] == "family"
    assert by_id["enter-report"][0] == "family"
    # The first step after a gate says where the review now is; no other step does.
    assert [step_id for step_id, _, lead in seen if lead] == [
        "step:item:fam-2",
    ]


def test_report_waits_until_everything_else_is_done() -> None:
    store = load("c-008")
    store.finish_step("answered")

    store.set_stage("report")
    assert store.state.stage == "wealth" and store.current_step.group == "wealth"

    # A point opened while the review is further on is gone back to before the report.
    while store.current_step.group != "family":
        store.finish_step(
            "answered" if store.current_step.kind != "point" else "for_meeting"
        )
    store.upsert_liability(type="mortgage", label="Second mortgage")
    while store.current_step.id != "enter-report":
        assert store.current_step.id != "closing"
        store.finish_step(
            "answered" if store.current_step.kind != "point" else "for_meeting"
        )
    assert not store.remaining()


def test_finishing_early_keeps_the_rest_for_the_meeting() -> None:
    store = load("c-008")
    store.finish_step("answered")
    open_before = {p.id for p in store.open_points()}

    left = store.finish_remaining()

    assert left > 5
    assert store.current_step.id == "enter-report"
    assert {p.id for p in store.open_points()} == open_before
    assert {s.outcome for s in store.state.agenda if s.kind == "point"} == {
        "for_meeting"
    }


def test_a_point_the_banker_asks_to_note_is_kept_and_not_asked_again() -> None:
    store = load("c-008")
    store.finish_step("answered")
    position = store.state.current_step_id

    point = store.add_meeting_point(
        "Invite the children to the next meeting.", "family"
    )

    noted = next(s for s in store.state.agenda if point.id in s.point_ids)
    assert (noted.status, noted.outcome, noted.origin) == (
        "done",
        "for_meeting",
        "banker",
    )
    assert store.state.current_step_id == position
    assert point.id in {p.id for p in store.open_points()}  # still goes to the report


def test_going_back_is_not_announced_as_a_new_section() -> None:
    store = load("c-008")
    step_brief(store)
    while store.current_step.group != "family":
        store.finish_step(
            "answered" if store.current_step.kind != "point" else "for_meeting"
        )
        step_brief(store)

    store.previous_step()

    assert "you are now on" not in step_brief(store)


def test_language_reaches_the_instructions_and_the_report_prompt() -> None:
    store = load("c-003")
    assert "# Language" not in build_instructions("wealth", store)

    store.set_language("fr")

    assert "Speak French with the banker" in build_instructions("wealth", store)
    assert "in French" in build_prompt(store)


def test_guided_instructions_do_not_show_the_other_points() -> None:
    store = load("c-008")
    guided = build_instructions("wealth", store)
    store.set_mode("listening")
    listening = build_instructions("wealth", store)

    # Warren can only wander off to what it can see.
    assert "Open meeting points" not in guided and "Open meeting points" in listening
    assert "Activity notes in the CRM" not in guided
    assert (
        "Sale of the Madrid apartment" in guided
    )  # the recorded data stays: recording needs it
