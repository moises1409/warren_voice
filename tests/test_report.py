import pytest
from conftest import load

from report import NarratedPoint, Narrative, generate_report, partial_summary

pytestmark = pytest.mark.asyncio


async def test_figures_and_points_survive_a_failing_text_model() -> None:
    store = load("c-003")
    open_ids = {p.id for p in store.open_points()}

    async def broken(prompt: str) -> Narrative:
        raise RuntimeError("model unavailable")

    report = await generate_report(store, narrator=broken)

    assert report.status == "ready"
    assert report.narrated is False
    assert {i for p in report.points for i in p.point_ids} == open_ids
    assert report.figures["aum_bank"] == pytest.approx(3_149_000)
    assert [s.key for s in report.assets_by_currency] == ["CHF", "EUR"]
    assert sum(s.share for s in report.assets_by_type) == pytest.approx(1)
    assert store.state.report["status"] == "ready"


async def test_narrative_cannot_drop_or_invent_points() -> None:
    store = load("c-003")
    first, *rest = [p.id for p in store.open_points()]

    async def partial(prompt: str) -> Narrative:
        return Narrative(
            summary="Summary.",
            points=[
                NarratedPoint(
                    point_ids=[first, "mp-999"], topic="Topic", opener="Opener?"
                ),
                NarratedPoint(
                    point_ids=["mp-998"], topic="Invented", opener="Invented?"
                ),
            ],
        )

    report = await generate_report(store, narrator=partial)

    assert report.narrated is True
    assert sorted(i for p in report.points for i in p.point_ids) == sorted(
        [first, *rest]
    )
    assert all("mp-99" not in i for p in report.points for i in p.point_ids)
    assert [p.section for p in report.points] == sorted(
        (p.section for p in report.points), key=["wealth", "family", "general"].index
    )


async def test_report_is_marked_generating_while_the_model_writes() -> None:
    store = load("c-001")
    seen: list[str] = []
    store.subscribe(
        lambda state: seen.append(state.report["status"]) if state.report else None
    )

    async def instant(prompt: str) -> Narrative:
        return Narrative(summary="Summary.", points=[])

    await generate_report(store, narrator=instant)

    assert seen == ["generating", "ready"]


async def test_gemini_writes_an_opener_for_every_point() -> None:
    """Calls the text model."""
    store = load("c-004")
    open_ids = {p.id for p in store.open_points()}

    report = await generate_report(store)

    assert report.narrated is True
    assert len(report.summary) > 80
    assert {i for p in report.points for i in p.point_ids} == open_ids
    assert all(p.opener.strip() and p.topic.strip() for p in report.points)


def test_summary_is_readable_while_it_is_still_being_written() -> None:
    assert partial_summary('{"summ') is None
    assert partial_summary('{"summary": "Elena is 54') == "Elena is 54"
    # Escapes are decoded, and half an escape is left for the next chunk.
    assert partial_summary('{"summary": "a \\"quoted\\" word\\') == 'a "quoted" word'
    assert partial_summary('{"summary": "Done.", "points": [') == "Done."


async def test_screen_gets_the_summary_as_it_grows() -> None:
    store = load("c-003")
    seen: list[str] = []
    store.subscribe(
        lambda state: seen.append(state.report["summary"]) if state.report else None
    )

    async def writer(prompt: str, on_summary) -> Narrative:
        on_summary("Sofia is an architect in Lugano.")
        on_summary(
            "Sofia is an architect in Lugano. Her wealth is mostly at the bank and in her studio."
        )
        return Narrative(summary="Final.", points=[])

    report = await generate_report(store, narrator=writer)

    assert seen[0] == "" and seen[-1] == "Final."
    assert "Sofia is an architect in Lugano." in seen
    # Who to invite is known before the model writes anything.
    assert report.experts and store.state.report["experts"]
