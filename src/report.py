"""The meeting report: figures computed from the data, wording from a text model."""

from __future__ import annotations

import datetime as dt
import inspect
import json
import logging
import os
import re
from collections import defaultdict
from collections.abc import Awaitable, Callable
from dataclasses import asdict
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field

from checks import age_on
from models import CamelModel, MeetingPoint, Section
from prompts import (
    KNOWLEDGE_DIR,
    LANGUAGES,
    family_state,
    succession_state,
    wealth_state,
)
from store import PrepStore
from summary import compute_totals

logger = logging.getLogger("agent")

REPORT_MODEL = os.environ.get("WARREN_REPORT_MODEL", "gemini-flash-latest")
SECTION_ORDER: list[Section] = ["wealth", "family", "general"]


class Slice(CamelModel):
    key: str
    value: float
    share: float


class ReportPoint(CamelModel):
    point_ids: list[str]
    section: Section
    topic: str
    opener: str


class Expert(CamelModel):
    """A bank expert worth inviting to the client meeting, and why."""

    id: str
    label: str
    reasons: list[str]
    # Amount at stake across the reasons, in base currency.
    amount: float


class Report(CamelModel):
    status: Literal["generating", "ready"]
    generated_at: dt.datetime | None = None
    # False when the text model was unavailable and the raw points are shown instead.
    narrated: bool = False
    summary: str = ""
    figures: dict[str, float] = Field(default_factory=dict)
    assets_by_type: list[Slice] = Field(default_factory=list)
    assets_by_currency: list[Slice] = Field(default_factory=list)
    assets_by_country: list[Slice] = Field(default_factory=list)
    points: list[ReportPoint] = Field(default_factory=list)
    experts: list[Expert] = Field(default_factory=list)


class NarratedPoint(BaseModel):
    point_ids: list[str]
    topic: str
    opener: str


class Narrative(BaseModel):
    """What the text model writes."""

    summary: str
    points: list[NarratedPoint]


# Writes the narrative. May be given a callback, called with the summary as far as it
# is written, so the screen can show it being written.
Narrator = Callable[..., Awaitable[Narrative]]
OnSummary = Callable[[str], None]


def _breakdown(store: PrepStore, attribute: str) -> list[Slice]:
    sums: dict[str, float] = defaultdict(float)
    for asset in store.state.assets:
        value = store.settings.to_base(asset.amount, asset.currency)
        if value:
            sums[getattr(asset, attribute) or "unknown"] += value
    total = sum(sums.values())
    return [
        Slice(key=key, value=value, share=value / total)
        for key, value in sorted(sums.items(), key=lambda kv: -kv[1])
    ]


def build_prompt(store: PrepStore, knowledge_dir: Path = KNOWLEDGE_DIR) -> str:
    client = store.state.client
    points = "\n".join(
        f"- {p.id} [{p.section}, {p.kind}]: {p.text}" for p in store.open_points()
    )
    return "\n\n".join(
        [
            "You write the preparation report a private banker reads before meeting a client.",
            (knowledge_dir / "report.md").read_text(encoding="utf-8"),
            "# The client\n\n"
            f"{client.name}, {age_on(client.date_of_birth, store.today)} years old, "
            f"domiciled in {client.domicile.city} ({client.domicile.country}). Segment: {client.segment}.",
            "# Wealth\n\n" + wealth_state(store),
            "# Family\n\n" + family_state(store),
            "# If the client died today\n\n" + succession_state(store),
            "# Open meeting points\n\n" + (points or "None."),
            *(
                [
                    f"# Language\n\nWrite the summary, the topics and the openers in {LANGUAGES[store.state.language][0]}."
                ]
                if store.state.language != "en"
                else []
            ),
            "# Your output\n\n"
            "Return `summary` (the situation in brief, three or four sentences) and `points`.\n"
            "Every open meeting point id must appear in exactly one entry of `points`; merge closely related "
            "points into one entry by listing several ids. For each entry give a `topic` (a title of at most six "
            "words) and an `opener` (one or two sentences the banker can say to the client).",
        ]
    )


def partial_summary(buffer: str) -> str | None:
    """The summary as far as it is written, from JSON that is still arriving."""
    match = re.search(r'"summary"\s*:\s*"((?:[^"\\]|\\.)*)', buffer)
    if not match:
        return None
    text = match.group(1)
    # A trailing backslash is half an escape: wait for the rest.
    if text.endswith("\\") and not text.endswith("\\\\"):
        text = text[:-1]
    try:
        return json.loads(f'"{text}"')
    except ValueError:
        return None


async def narrate_with_gemini(
    prompt: str, on_summary: OnSummary | None = None
) -> Narrative:
    from google import genai
    from google.genai import errors, types

    client = genai.Client()

    async def write(thinking: types.ThinkingConfig | None) -> Narrative:
        stream = await client.aio.models.generate_content_stream(
            model=REPORT_MODEL,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=Narrative,
                temperature=0.4,
                thinking_config=thinking,
            ),
        )
        buffer = ""
        async for chunk in stream:
            buffer += chunk.text or ""
            if on_summary and (summary := partial_summary(buffer)):
                on_summary(summary)
        return Narrative.model_validate_json(buffer)

    try:
        # With its default thinking the model stays silent for about ten seconds and then
        # delivers everything at once. At "low" the text starts within a second and the
        # banker sees it being written (measured: 3s in all, against 10s to 20s).
        return await write(types.ThinkingConfig(thinking_level="low"))
    except errors.ClientError:
        # A model that does not take a thinking level: let it think as it does by default.
        return await write(None)


def _assemble(
    points: list[MeetingPoint], narrative: Narrative | None
) -> list[ReportPoint]:
    """One report entry per open point, in section order; nothing lost, nothing invented."""
    by_id = {p.id: p for p in points}
    entries: list[ReportPoint] = []
    used: set[str] = set()
    for item in narrative.points if narrative else []:
        ids = [i for i in item.point_ids if i in by_id and i not in used]
        if not ids:
            continue
        used.update(ids)
        entries.append(
            ReportPoint(
                point_ids=ids,
                section=by_id[ids[0]].section,
                topic=item.topic,
                opener=item.opener,
            )
        )
    for point in points:
        if point.id not in used:
            entries.append(
                ReportPoint(
                    point_ids=[point.id],
                    section=point.section,
                    topic=point.kind.capitalize(),
                    opener=point.text,
                )
            )
    entries.sort(key=lambda e: SECTION_ORDER.index(e.section))
    return entries


def _experts(store: PrepStore, points: list[MeetingPoint]) -> list[Expert]:
    """Who to invite, from the open points that name an expert; largest amount first."""
    labels = (store.state.succession or {}).get("experts", {})
    found: dict[str, Expert] = {}
    for point in points:
        if not point.expert:
            continue
        expert = found.setdefault(
            point.expert,
            Expert(
                id=point.expert,
                label=labels.get(point.expert, point.expert),
                reasons=[],
                amount=0.0,
            ),
        )
        expert.reasons.append(point.text)
        expert.amount += point.amount or 0.0
    return sorted(found.values(), key=lambda e: -e.amount)


async def generate_report(
    store: PrepStore,
    narrator: Narrator = narrate_with_gemini,
    knowledge_dir: Path = KNOWLEDGE_DIR,
) -> Report:
    """Build the report and put it in the store. Figures never depend on the model."""
    totals = compute_totals(store.state, store.settings)
    base: dict[str, Any] = {
        "figures": asdict(totals),
        "assets_by_type": _breakdown(store, "type"),
        "assets_by_currency": _breakdown(store, "currency"),
        "assets_by_country": _breakdown(store, "country"),
    }
    points = store.open_points()
    # Who to invite does not depend on the model either.
    base["experts"] = _experts(store, points)
    draft = Report(status="generating", **base)
    store.set_report(draft.model_dump(by_alias=True, mode="json"))

    def on_summary(text: str) -> None:
        # The summary on screen grows as the model writes it.
        if len(text) - len(draft.summary) >= 12:
            draft.summary = text
            store.set_report(draft.model_dump(by_alias=True, mode="json"))

    narrative: Narrative | None = None
    try:
        prompt = build_prompt(store, knowledge_dir)
        if len(inspect.signature(narrator).parameters) > 1:
            narrative = await narrator(prompt, on_summary)
        else:
            narrative = await narrator(prompt)
    except Exception:
        logger.exception("report narrative failed; falling back to the raw points")

    report = Report(
        status="ready",
        generated_at=dt.datetime.now(dt.timezone.utc),
        narrated=narrative is not None,
        summary=narrative.summary if narrative else "",
        points=_assemble(points, narrative),
        **base,
    )
    store.set_report(report.model_dump(by_alias=True, mode="json"))
    return report
