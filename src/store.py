"""The state of one preparation session and the only way to change it.

Every mutation re-runs the deterministic checks, bumps the revision and
notifies subscribers, so the screen always shows what the agent just recorded.
"""

from __future__ import annotations

import datetime as dt
import json
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any, TypeVar

from agenda import build_agenda, next_pending
from checks import Finding, run_checks
from fx import DATA_DIR, Settings
from models import (
    DEFAULT_BANKABLE,
    Asset,
    CamelModel,
    CashFlow,
    Dossier,
    FamilyMember,
    Language,
    Liability,
    MeetingPoint,
    Mode,
    Pension,
    PointKind,
    PointSource,
    PointStatus,
    PrepState,
    Scenario,
    Section,
    Stage,
    Step,
    StepOutcome,
)
from sessions import SessionStore
from succession import simulate

T = TypeVar("T", bound=CamelModel)


class ClientNotFoundError(LookupError):
    pass


class ItemNotFoundError(LookupError):
    pass


def load_dossiers(data_dir: Path = DATA_DIR) -> list[Dossier]:
    raw = json.loads((data_dir / "clients.json").read_text(encoding="utf-8"))
    return [Dossier.model_validate(entry) for entry in raw["clients"]]


class PrepStore:
    def __init__(
        self,
        dossier: Dossier,
        settings: Settings,
        today: dt.date | None = None,
        sessions: SessionStore | None = None,
        saved: PrepState | None = None,
    ) -> None:
        self.settings = settings
        self.today = today or dt.date.today()
        # A saved session carries on from where it was left; otherwise the client file.
        self.state = saved or PrepState.model_validate(dossier.model_dump())
        self._sessions = sessions
        self._listeners: list[Callable[[PrepState], None]] = []
        # The step Warren last presented, to tell when the review enters another group.
        self._presented: str | None = None
        self._sync_findings()
        self._sync_agenda()

    @classmethod
    def load(
        cls,
        client_id: str,
        data_dir: Path = DATA_DIR,
        today: dt.date | None = None,
        sessions: SessionStore | None = None,
        reset: bool = False,
    ) -> PrepStore:
        """The client's session: the saved one if `sessions` has it, else a new one.

        `reset` discards the saved session. A saved session nobody has worked on
        (written by the seed command) is rebuilt from the client file, which may
        have changed since.
        """
        for dossier in load_dossiers(data_dir):
            if dossier.client.id == client_id:
                saved = None
                if sessions and not reset:
                    saved = sessions.load(client_id)
                    if saved and saved.rev == 0:
                        saved = None
                return cls(dossier, Settings.load(data_dir), today, sessions, saved)
        raise ClientNotFoundError(client_id)

    def save(self) -> None:
        if self._sessions:
            self._sessions.save(self.state)

    # --- reading -----------------------------------------------------------

    def snapshot(self) -> str:
        """The full state as camelCase JSON, as sent to the frontend."""
        return self.state.model_dump_json(by_alias=True)

    def subscribe(self, listener: Callable[[PrepState], None]) -> None:
        self._listeners.append(listener)

    def open_points(self, section: Section | None = None) -> list[MeetingPoint]:
        return [
            p
            for p in self.state.meeting_points
            if p.status == "open" and (section is None or p.section == section)
        ]

    # --- wealth ------------------------------------------------------------

    def upsert_asset(self, item_id: str | None = None, **fields: Any) -> Asset:
        if item_id is None and fields.get("bankable") is None:
            if fields.get("bank"):
                fields["bankable"] = True
            else:
                fields["bankable"] = DEFAULT_BANKABLE.get(fields.get("type", ""))
        return self._upsert(self.state.assets, Asset, "ast", item_id, fields)

    def upsert_liability(self, item_id: str | None = None, **fields: Any) -> Liability:
        return self._upsert(self.state.liabilities, Liability, "lia", item_id, fields)

    def upsert_pension(self, item_id: str | None = None, **fields: Any) -> Pension:
        return self._upsert(self.state.pensions, Pension, "pen", item_id, fields)

    def upsert_cash_flow(self, item_id: str | None = None, **fields: Any) -> CashFlow:
        return self._upsert(self.state.cash_flows, CashFlow, "cf", item_id, fields)

    # --- family ------------------------------------------------------------

    def set_family(
        self,
        marital_status: str | None = None,
        has_children: bool | None = None,
        marital_regime: str | None = None,
        has_will: bool | None = None,
    ) -> None:
        family = self.state.family
        updates = {}
        if marital_status is not None:
            updates["marital_status"] = marital_status
        if has_children is not None:
            updates["has_children"] = has_children
        if marital_regime is not None:
            updates["marital_regime"] = marital_regime
        if has_will is not None:
            updates["has_will"] = has_will
        self.state.family = type(family).model_validate(
            {**family.model_dump(), **updates}
        )
        self._commit()

    def upsert_family_member(
        self, item_id: str | None = None, **fields: Any
    ) -> FamilyMember:
        members = self.state.family.members
        if fields.get("other_parent_id") and not any(
            m.id == fields["other_parent_id"] for m in members
        ):
            raise ItemNotFoundError(fields["other_parent_id"])
        member = self._upsert(
            members, FamilyMember, "fam", item_id, fields, commit=False
        )
        if member.relation == "child":
            self.state.family.has_children = True
        self._commit()
        return member

    # --- any item ----------------------------------------------------------

    def remove_item(self, item_id: str) -> None:
        state = self.state
        for items in (
            state.assets,
            state.liabilities,
            state.pensions,
            state.cash_flows,
            state.family.members,
        ):
            for index, item in enumerate(items):
                if item.id == item_id:
                    del items[index]
                    for liability in state.liabilities:
                        if liability.secured_by_asset_id == item_id:
                            liability.secured_by_asset_id = None
                    for member in state.family.members:
                        if member.other_parent_id == item_id:
                            member.other_parent_id = None
                    self._commit()
                    return
        raise ItemNotFoundError(item_id)

    # --- meeting points ----------------------------------------------------

    def add_meeting_point(
        self,
        text: str,
        section: Section,
        kind: PointKind = "topic",
        source: PointSource = "agent",
        related_item_id: str | None = None,
    ) -> MeetingPoint:
        point = MeetingPoint(
            id=self._new_id(self.state.meeting_points, "mp"),
            section=section,
            kind=kind,
            text=text,
            source=source,
            related_item_id=related_item_id,
        )
        self.state.meeting_points.append(point)
        self._commit()
        return point

    def update_meeting_point(
        self,
        point_id: str,
        text: str | None = None,
        status: PointStatus | None = None,
    ) -> MeetingPoint:
        point = self._find(self.state.meeting_points, point_id)
        updates = {}
        if text is not None:
            updates["text"] = text
        if status is not None:
            # A rule point is only truly resolved by fixing the data. Closing it
            # by hand is a dismissal, which the next check run leaves alone.
            if point.rule_key and status == "resolved":
                status = "dismissed"
            updates["status"] = status
        self._replace(self.state.meeting_points, point, updates)
        self._commit()
        return self._find(self.state.meeting_points, point_id)

    # --- session -----------------------------------------------------------

    def set_stage(self, stage: Stage) -> None:
        """Move to a stage. In a guided review, to the first step still to do there."""
        if self.state.mode == "guided":
            if stage == "report" and self.remaining():
                # The report comes when everything else has been gone through.
                return
            self.state.stage = stage
            for step in self.state.agenda:
                if step.stage == stage and step.status == "pending":
                    self.state.current_step_id = step.id
                    self._show(step)
                    break
        else:
            self.state.stage = stage
        self._commit()

    # --- guided review -----------------------------------------------------

    @property
    def current_step(self) -> Step | None:
        return next(
            (s for s in self.state.agenda if s.id == self.state.current_step_id), None
        )

    def progress(self) -> tuple[int, int]:
        """Position of the current step and number of steps, for "3 of 7"."""
        ids = [s.id for s in self.state.agenda]
        current = self.state.current_step_id
        return (ids.index(current) + 1 if current in ids else len(ids)), len(ids)

    def remaining(self) -> list[Step]:
        """The steps still to do before the report."""
        return [
            s
            for s in self.state.agenda
            if s.status == "pending" and s.group != "report"
        ]

    def entered(self) -> str | None:
        """The group the review has just entered, when the banker agreed to move on at a gate
        and the current step is being presented for the first time. Answers once per step.
        """
        agenda = self.state.agenda
        ids = [s.id for s in agenda]
        current, before = self.state.current_step_id, self._presented
        self._presented = current
        if current not in ids or before not in ids:
            return None
        i, j = ids.index(before), ids.index(current)
        if j <= i or agenda[i].kind != "gate" or agenda[i].group == agenda[j].group:
            return None
        return agenda[j].group

    def finish_remaining(self) -> int:
        """Keep every point still to review for the meeting and go to the end of the review.

        For when the banker wants the report without going through the rest.
        """
        left = self.remaining()
        for step in left:
            step.status = "done"
            step.outcome = "for_meeting" if step.kind == "point" else "skipped"
        self._commit()
        return len(left)

    def set_language(self, language: Language) -> None:
        self.state.language = language
        self._commit()

    def set_mode(self, mode: Mode) -> None:
        self.state.mode = mode
        if mode == "guided" and self.current_step:
            self._show(self.current_step)
        self._commit()

    def finish_step(self, outcome: StepOutcome) -> None:
        """Close the current step and move to the next one still to do."""
        step = self.current_step
        if step is None:
            return
        if outcome == "dismissed":
            for point in self.state.meeting_points:
                if point.id in step.point_ids and point.status == "open":
                    point.status = "dismissed"
        step.status, step.outcome = "done", outcome
        if step.kind == "offer" and outcome != "answered":
            # Declined: nothing of the simulation is gone through. The costs of
            # inaction stay open, so they still reach the report.
            for other in self.state.agenda:
                if other.group == "simulation" and other.status == "pending":
                    other.status, other.outcome = "done", "skipped"
        self._commit()

    def go_to_step(self, step_id: str) -> None:
        """Jump to a step, reopening it if it was done."""
        step = next((s for s in self.state.agenda if s.id == step_id), None)
        if step is None:
            raise ItemNotFoundError(step_id)
        step.status, step.outcome = "pending", None
        self.state.current_step_id = step.id
        self._show(step)
        self._commit()

    def previous_step(self) -> None:
        """Go back to the nearest earlier step that can still be discussed."""
        agenda = self.state.agenda
        ids = [s.id for s in agenda]
        current = self.state.current_step_id
        index = ids.index(current) if current in ids else len(ids)
        open_ids = {p.id for p in self.open_points()}
        for step in reversed(agenda[:index]):
            # A point step whose points all closed has nothing left to discuss.
            if step.kind != "point" or open_ids & set(step.point_ids):
                self.go_to_step(step.id)
                return

    def _show(self, step: Step) -> None:
        """Put on screen what the step is about."""
        self.state.stage = step.stage
        self.state.scenario = step.scenario

    def set_scenario(self, scenario: Scenario | None) -> None:
        """Show a simulation on screen, or go back to today's picture."""
        self.state.scenario = scenario
        self._commit()

    def set_report(self, report: dict[str, Any] | None) -> None:
        self.state.report = report
        self._commit()

    # --- internals ---------------------------------------------------------

    @staticmethod
    def _find(items: list[T], item_id: str) -> T:
        for item in items:
            if item.id == item_id:
                return item
        raise ItemNotFoundError(item_id)

    @staticmethod
    def _replace(items: list[T], item: T, updates: dict[str, Any]) -> T:
        # Re-validate so a bad value from a tool call is rejected, not stored.
        updated = type(item).model_validate({**item.model_dump(), **updates})
        items[items.index(item)] = updated
        return updated

    @staticmethod
    def _new_id(items: list[Any], prefix: str) -> str:
        pattern = re.compile(rf"^{prefix}-(\d+)$")
        used = [int(m.group(1)) for i in items if (m := pattern.match(i.id))]
        return f"{prefix}-{max(used, default=0) + 1}"

    def _upsert(
        self,
        items: list[T],
        model: type[T],
        prefix: str,
        item_id: str | None,
        fields: dict[str, Any],
        commit: bool = True,
    ) -> T:
        # None means "not mentioned": it never erases what is already known.
        fields = {k: v for k, v in fields.items() if v is not None}
        for key in ("currency", "country"):
            if isinstance(fields.get(key), str):
                fields[key] = fields[key].strip().upper()
        if item_id is None:
            item = model.model_validate({"id": self._new_id(items, prefix), **fields})
            items.append(item)
        else:
            item = self._replace(items, self._find(items, item_id), fields)
        if commit:
            self._commit()
        return item

    def _commit(self) -> None:
        self._sync_findings()
        self._sync_agenda()
        self.state.rev += 1
        self.save()
        for listener in self._listeners:
            listener(self.state)

    def _sync_agenda(self) -> None:
        """Rebuild the review from the meeting points and keep its place."""
        state = self.state
        before = state.current_step_id
        state.agenda = build_agenda(state, self.settings, self.today, state.agenda)
        current = self.current_step
        if current is None or current.status == "done":
            state.current_step_id = next_pending(state.agenda, before)
        # The screen follows the review only when it moves to another step, so that
        # what the banker switched by hand during a step stays as they left it.
        if state.mode == "guided" and state.current_step_id != before:
            step = self.current_step
            if step:
                self._show(step)

    def _sync_findings(self) -> None:
        """Keep rule-based meeting points in line with the current findings."""
        succession = simulate(self.state, self.settings)
        self.state.succession = succession.model_dump(by_alias=True, mode="json")
        findings: dict[str, Finding] = {
            f.key: f
            for f in run_checks(self.state, self.settings, self.today, succession)
        }
        points = self.state.meeting_points
        seen: set[str] = set()
        for point in points:
            if point.rule_key is None:
                continue
            seen.add(point.rule_key)
            finding = findings.get(point.rule_key)
            if finding is None:
                if point.status == "open":
                    point.status = "resolved"
            else:
                point.text = finding.text
                point.expert = finding.expert
                point.amount = finding.amount
                if point.status == "resolved":
                    point.status = "open"
        for key, finding in findings.items():
            if key not in seen:
                points.append(
                    MeetingPoint(
                        id=self._new_id(points, "mp"),
                        section=finding.section,
                        kind=finding.kind,
                        text=finding.text,
                        source="rule",
                        related_item_id=finding.related_item_id,
                        rule_key=key,
                        expert=finding.expert,
                        amount=finding.amount,
                    )
                )
