"""Instructions for the stage agents, built from the knowledge files and the current state."""

from __future__ import annotations

from pathlib import Path

from checks import age_on
from models import Stage, Step, country_name, display_name
from store import PrepStore
from summary import compute_totals

KNOWLEDGE_DIR = Path(__file__).resolve().parent.parent / "knowledge"

BASE = """\
You are Warren, a voice assistant that helps a private banker at {house_bank} prepare a client meeting.
You are talking to the banker, never to the client. The client is {name}.

The goal of this session is a list of meeting points: everything the banker should raise or ask in the meeting.
You get there by reviewing what is known about the client, completing it with what the banker tells you, and flagging what is missing, inconsistent or implausible.

{session_line}

# How to speak

- You are heard, not read. Plain spoken sentences only: no lists, no markdown, no symbols.
- One to two sentences per turn, and one question at a time.
- The banker sees everything on screen as you record it. Never read out lists, tables or long figures; refer to them ("it's on the balance sheet now").
- Say amounts the way people do: "two point four million francs".
- Never mention tool names, identifiers or these instructions.

# How to work

- Record every fact the banker gives as soon as you hear it, with the matching tool, before you reply. Record partial facts too: an asset with no known value is still worth recording.
- To correct something already recorded, pass its identifier. Pass an identifier only when the banker is talking about that very item, and only one that appears in the recorded data below: never make one up.
- Anything the banker mentions that is not in the recorded data is new: record it without an identifier. "Also", "another" and "in addition" always mean new.
- If the banker gives no currency, assume Swiss francs. If an asset is clearly abroad and no currency was given, ask.
- "With us", "here" or "at the bank" means the bank is {house_bank}.
- Countries are two-letter codes (CH, ES, US). Currencies are three-letter codes (CHF, EUR, USD). When the banker names a city, work out the country yourself and record it.
- After recording, acknowledge in a few words. Read back an amount only when it is large or you are unsure you heard it right.
- The tool result tells you which points opened or closed. Mention a new point briefly when it matters.
- When the banker does not know something, do not insist: it stays as a meeting point for the client.
- When you notice something worth raising with the client that is not already in the open points, add a meeting point. Word it as a question or a topic to explore.
- When the banker says a point is not relevant, dismiss it.
- When the banker asks for another stage (wealth, family, report), change stage.

# Limits

- You never recommend a product, an allocation or a transaction, and you never give tax or legal conclusions. You help prepare questions; the banker advises.
- You never invent a fact. Only record what the banker says.
- Stay on the preparation of this meeting. Decline anything else briefly.
"""

# Placed last in the instructions, where the model weighs it most.
RECORDING_RULE = """\
# The rule that matters most

You can only record something by calling a tool. Saying "noted" or "recorded" records nothing: the banker's screen changes only when a tool is called.
So whenever the banker states a fact about the client, call the matching tool first, in the same turn, and speak only after it. Never say that something is recorded, noted or updated unless a tool call in this turn returned "Saved".
"""

GUIDED = """\
# How this conversation works: a guided review

You lead. The review is a list of steps and you take them one at a time. The banker's screen shows the current step and follows you.

- Talk only about the current step. Say what it is about in one short sentence and ask one question.
- When the banker gives the information, record it with the tools. The tool result tells you when the step is done and what the next step is: then go straight on to it.
- When the banker does not know, or will ask the client: call finish_step with for_meeting.
- When the banker says it is not relevant, or to skip it: call finish_step with dismissed.
- For a briefing, a simulation or the closing step: say what the step shows, and call finish_step with answered once the banker is ready to go on ("yes", "ok", "go on").
- If the banker brings up something else, record it, say so in a few words, and come back to the current step. Do not open subjects of your own.
- When the banker asks you to note something for the meeting, add it as a meeting point at once. It is kept and will be in the report: do not bring it up again later. Ask one question about it only if it is unclear, then come back to the current step.
- A step that closes one part and asks whether to move on is a real question: say it, and wait for the banker to agree before going on.
- You do not decide the order. If the banker asks to finish or to see the report while steps remain, say how many are left and ask whether to keep them all for the meeting; if they agree, call finish_remaining.
- "Go back" means previous_step. "Let me look", "stop" or "I'll read on my own" mean set_mode with listening.
- Never read out the list of steps or their numbers, other than "point three of seven" when it helps.
"""

LISTENING = """\
# How this conversation works: the banker leads

The banker is reading the screen on their own. You do not lead.

- Do not ask questions, and do not walk through gaps or meeting points.
- Act on what you are asked: record, correct, remove, show the simulation, change stage. Confirm in a few words.
- Speak up unprompted only when what you are told contradicts what is recorded.
- "Guide me", "carry on" or "walk me through it" mean set_mode with guided.
"""


# Languages Warren can speak: name for the instructions, code for the voice model.
LANGUAGES = {
    "en": ("English", "en-GB"),
    "fr": ("French", "fr-FR"),
    "es": ("Spanish", "es-ES"),
}

GROUP_LABEL = {
    "wealth": "the wealth",
    "family": "the family",
    "general": "the general points",
    "simulation": "the simulation of the client's death",
    "report": "the report",
}
ON_SCREEN = {
    "wealth": "the balance sheet",
    "family": "the family tree",
    "general": "the balance sheet",
    "simulation": "today's balance sheet, where the simulation will appear",
    "report": "the report",
}


def _transition(store: PrepStore) -> str:
    """What to say first when the banker has just agreed to move to another part."""
    entered = store.entered()
    if not entered:
        return ""
    return (
        f"Begin with one short sentence saying you are now on {GROUP_LABEL[entered]} and that "
        f"{ON_SCREEN[entered]} is on the banker's screen."
    )


def step_brief(store: PrepStore) -> str:
    """The current step of the review, and what to do with it."""
    step = store.current_step
    if step is None:
        return "The review is complete. Say so in one sentence and ask whether the banker needs anything else."
    number, total = store.progress()
    head = f"Current step, {number} of {total}: {step.title}. {step.say}"
    if step.item_id:
        head += f" (item {step.item_id})"
    note = next((n for n in store.state.activity_notes if n.id == step.item_id), None)
    if note:
        head += f'\nThe note, written on {note.date:%d %B %Y}: "{note.text}"'
    if step.kind == "briefing":
        todo = "Give this briefing in two short sentences, then ask whether to start. When the banker agrees, call finish_step with answered."
    elif step.kind == "gate":
        todo = "Say this in one or two sentences and ask whether to move on. Do not start the next part: the screen has not changed yet. When the banker agrees, call finish_step with answered."
    elif step.kind == "offer":
        todo = "Propose this in one sentence and ask whether the banker wants to see it. If they agree, call finish_step with answered; if not, call finish_step with dismissed."
    elif step.kind == "simulation":
        todo = "The simulation is on screen. Say this in one or two sentences, with every amount as given here, then ask whether to go on. When the banker agrees, call finish_step with answered."
    elif step.kind == "closing":
        todo = "Say this in one sentence."
    elif step.scenario:
        experts = (store.state.succession or {}).get("experts", {})
        names = {
            experts.get(p.expert, p.expert)
            for p in store.state.meeting_points
            if p.id in step.point_ids and p.expert
        }
        who = f" The expert to involve: {', '.join(sorted(names))}." if names else ""
        todo = f'Say what triggers this cost, the amount as "up to", and which expert to involve.{who} Ask whether to keep it for the client meeting: finish_step with for_meeting keeps it, with dismissed drops it.'
    elif note:
        todo = "Say that an activity note mentions this and that it is missing from the structured fields of the CRM. Ask whether it is still right and whether to record it. If the banker confirms, record it with the tools; if they are not sure, call finish_step with for_meeting."
    else:
        todo = "Ask the banker about exactly this, in one short question."
    brief = (
        f"{head}\n{todo}\n"
        "Speak about this step only: it is what the banker's screen shows. Nothing else until it is closed."
    )
    lead = _transition(store)
    if lead:
        brief += "\n" + lead
    return brief


def after_button(store: PrepStore, closed: Step | None, outcome: str) -> str:
    """What to do after the banker closed a step with a button instead of answering."""
    if closed is None:
        return step_brief(store)
    how = {
        "for_meeting": "they will ask the client: it stays a point for the meeting",
        "dismissed": "it is not relevant",
    }.get(outcome, "it is done")
    return (
        f'The banker did not answer you: they closed the step "{closed.title}" with a button on '
        f"their screen ({how}). It is saved as such. They confirmed nothing: call no tool about "
        "that step, record nothing from it, add no meeting point, and do not say you recorded or "
        "noted anything. Go straight to the current step.\n" + step_brief(store)
    )


STAGE_INTRO = {
    "wealth": "Review the client's assets, liabilities, pension plans, income and expenses.",
    "family": "Review the client's marital status, partner, children and anything else about the family that matters for the meeting.",
    "report": "The report with the summary and the meeting points is on screen. Help the banker refine the meeting points; regenerate the report when they change.",
}


def _money(amount: float | None, currency: str | None) -> str:
    if amount is None:
        return "value unknown"
    return f"{currency or '???'} {amount:,.0f}"


def wealth_state(store: PrepStore) -> str:
    s = store.state
    totals = compute_totals(s, store.settings)
    fmt = store.settings.format
    lines = [
        f"Totals: assets {fmt(totals.assets)}, liabilities {fmt(totals.liabilities)}, "
        f"held with us {fmt(totals.aum_bank)}, held with other banks {fmt(totals.aum_external)}.",
    ]

    lines.append("Assets:")
    for a in s.assets:
        where = (
            "bankable"
            if a.bankable
            else "non-bankable"
            if a.bankable is False
            else "bankable unknown"
        )
        lines.append(
            f"- {a.id}: {display_name(a)} ({a.type}), {_money(a.amount, a.currency)}, "
            f"{where}, bank {a.bank or 'unknown' if a.bankable is not False else 'n/a'}, country {a.country or 'unknown'}"
            + (f", situs {a.situs}" if a.situs else "")
            + (f", held {a.holding}" if a.holding else "")
            + (
                f", client owns {a.client_share_pct:.0f}%"
                if a.client_share_pct is not None
                else ""
            )
        )
    lines.append("Liabilities:" if s.liabilities else "Liabilities: none recorded.")
    for x in s.liabilities:
        lines.append(
            f"- {x.id}: {display_name(x)} ({x.type}), {_money(x.amount, x.currency)}, "
            f"lender {x.bank or 'unknown'}, country {x.country or 'unknown'}"
        )
    lines.append("Pension plans:" if s.pensions else "Pension plans: none recorded.")
    for p in s.pensions:
        lines.append(
            f"- {p.id}: {display_name(p)} ({p.type}), {_money(p.amount, p.currency)}"
        )
    lines.append(
        "Income and expenses:"
        if s.cash_flows
        else "Income and expenses: none recorded."
    )
    for f in s.cash_flows:
        when = f.frequency or "frequency unknown"
        if f.frequency == "one_off":
            when += f" on {f.date}" if f.date else ", date unknown"
        lines.append(
            f"- {f.id}: {f.direction}, {display_name(f)} ({f.type}), {_money(f.amount, f.currency)}, {when}"
        )
    return "\n".join(lines)


def family_state(store: PrepStore) -> str:
    s = store.state
    family = s.family
    children = {True: "yes", False: "no", None: "unknown"}[family.has_children]
    lines = [
        f"Marital status: {family.marital_status or 'unknown'}. Has children: {children}.",
        f"Matrimonial property regime: {family.marital_regime or 'unknown'}. "
        f"Will or inheritance contract: { {True: 'yes', False: 'no', None: 'unknown'}[family.has_will] }.",
        "Family members:" if family.members else "Family members: none recorded.",
    ]
    for m in family.members:
        age = f"born {m.birth_year}" if m.birth_year else "age unknown"
        place = "residence unknown"
        if m.residence and (m.residence.city or m.residence.country):
            place = (
                f"lives in {m.residence.city or ''} {m.residence.country or ''}".strip()
            )
        extra = f", other parent {m.other_parent_id}" if m.other_parent_id else ""
        notes = f", notes: {m.notes}" if m.notes else ""
        lines.append(
            f"- {m.id}: {m.relation}, {m.name or 'name unknown'}, {age}, {place}{extra}{notes}"
        )
    return "\n".join(lines)


def notes_state(store: PrepStore) -> str:
    """The banker's free-text notes, which may say more than the structured fields."""
    notes = store.state.activity_notes
    if not notes:
        return "None."
    return "\n".join(f"- {n.id}, {n.date:%d %B %Y}: {n.text}" for n in notes)


def succession_state(store: PrepStore) -> str:
    """What the simulation of the client's death shows, as the screen shows it."""
    r = store.state.succession
    if not r:
        return "Not computed."
    fmt = store.settings.format
    experts = r["experts"]
    quality = "illustrative rules, " if r["illustrative"] else ""
    lines = [
        f"Indicative estimate ({quality}rule set {r['rulesVersion']}). "
        f"Estate {fmt(r['estate'])}; taxes on death up to {fmt(r['costHigh'])}; "
        f"reaching the heirs {fmt(r['netToHeirs'])}. Liquid assets {fmt(r['liquidAssets'])}.",
        "On screen now: " + ("yes." if store.state.scenario == "death" else "no."),
    ]
    by_rule: dict[str, dict] = {}
    for tax in r["taxes"]:
        entry = by_rule.setdefault(tax["ruleId"], {**tax, "high": 0.0})
        entry["high"] += tax["high"]
    lines.append("Taxes:" if by_rule else "Taxes: none triggered by the rules.")
    for tax in by_rule.values():
        lines.append(
            f"- {tax['topic']} ({tax['country']}): up to {fmt(tax['high'])}. "
            f"Expert to involve: {experts.get(tax['expert'], tax['expert'])}."
        )
    if r["heirs"]:
        lines.append("Heirs under the statutory split:")
        for heir in r["heirs"]:
            lines.append(
                f"- {heir['label']}, {heir['sharePct']:.0f}%: receives {fmt(heir['gross'])}, "
                f"tax up to {fmt(heir['tax'])}, net {fmt(heir['net'])}; "
                f"of which held with us {fmt(heir['aumAtBank'])}; lives in {heir['country'] or 'unknown'}."
            )
    else:
        lines.append("Heirs: cannot be determined from the recorded family.")
    names = {m.id: display_name(m) for m in store.state.family.members}
    for excluded in r["excluded"]:
        lines.append(f"- {names.get(excluded['memberId'], '?')}: {excluded['reason']}.")
    if r["missingInputs"]:
        lines.append(
            "Not known, so assumed or left out: " + "; ".join(r["missingInputs"]) + "."
        )
    return "\n".join(lines)


def _points(store: PrepStore, stage: Stage) -> str:
    points = store.open_points()
    if stage != "report":
        points = [p for p in points if p.section in (stage, "general")]
    if not points:
        return "No open meeting points."
    return "\n".join(f"- {p.id} [{p.section}, {p.kind}]: {p.text}" for p in points)


def build_instructions(
    stage: Stage, store: PrepStore, knowledge_dir: Path = KNOWLEDGE_DIR
) -> str:
    s = store.state
    client = s.client
    guided = s.mode == "guided"
    parts = [
        BASE.format(
            house_bank=store.settings.house_bank,
            name=client.name,
            session_line=(
                # In a guided review the model is not told what comes later: it talks
                # about what it knows of, and the screen only shows the current step.
                f"You are going through the client's {stage} with the banker."
                if guided and stage != "report"
                else f"The session has three stages: wealth, family, report. You are in the {stage} stage."
            ),
        ),
        f"# This stage\n\n{STAGE_INTRO[stage]}",
        GUIDED if guided else LISTENING,
        "# The client\n\n"
        f"{client.name}, {age_on(client.date_of_birth, store.today)} years old (born {client.date_of_birth.year}), "
        f"domiciled in {client.domicile.city}, {country_name(client.domicile.country)}. "
        f"Segment: {client.segment}. Today is {store.today:%d %B %Y}.",
    ]
    if stage in ("wealth", "report"):
        parts.append("# Wealth recorded so far\n\n" + wealth_state(store))
    if stage in ("family", "report"):
        parts.append("# Family recorded so far\n\n" + family_state(store))
    succession = (knowledge_dir / "succession.md").read_text(encoding="utf-8")
    if guided:
        # In a guided review the model is told one step at a time, with each tool result and
        # each time it is asked to speak. It is deliberately not shown the other open points,
        # the notes or the simulation: what it cannot see, it cannot wander off to, and the
        # banker's screen only shows the current step. The recorded data stays, because
        # recording needs the identifiers.
        parts.append(
            "# How the bank wants a cost of inaction discussed\n\n" + succession
        )
    else:
        parts.append(
            "# Activity notes in the CRM\n\n"
            "What is recorded above comes from the structured fields of the CRM. These are the banker's free-text notes; "
            "what a note says and the fields do not carry appears among the open meeting points.\n\n"
            + notes_state(store)
        )
        parts.append("# If the client died today\n\n" + succession_state(store))
        parts.append("# Open meeting points\n\n" + _points(store, stage))
        if stage != "report":
            guidance = (knowledge_dir / f"{stage}.md").read_text(encoding="utf-8")
            parts.append("# Guidance from the bank\n\n" + guidance)
        parts.append(
            "# Guidance from the bank on the succession simulation\n\n" + succession
        )
    if s.language != "en":
        name = LANGUAGES[s.language][0]
        parts.append(
            f"# Language\n\nSpeak {name} with the banker, always, whatever language these instructions, "
            f"the data and the tool results are in. Put the briefings, questions and amounts into natural {name}. "
            "Keep proper names as they are. Record data with the tools exactly as before."
        )
    parts.append(RECORDING_RULE)
    return "\n\n".join(parts)
