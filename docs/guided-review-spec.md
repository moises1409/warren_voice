# Warren — Guided review

Spec, design and plan · 4 October 2026 · Status: **implemented** (branch `meeting-prep`); see section 11 for what differs from the proposal

Extends `meeting-prep-design.md` and `cost-of-inaction-spec.md`.

---

## 1. Problem

Once the conversation starts, the screen and Warren compete. The screen shows everything at
once (three stages, every item, every meeting point); Warren talks through the gaps in an
order of its own. The banker cannot tell whether to follow the voice or read the screen, where
to start, or when to look at another view.

## 2. Goal

Make it obvious at every moment who is leading.

- **Before the conversation**, the banker reads on their own, with everything visible,
  including the meeting points.
- **In the conversation**, one of two modes, always explicit:
  - **Guided** (default): Warren leads, one point at a time, and the screen follows.
  - **Listening**: the banker leads; Warren acts on what it is asked and otherwise stays quiet.
- The banker can switch mode at any time, and a guided review that is interrupted **resumes
  where it stopped**, in the same conversation or in a later one.

## 3. The three states of the page

| State | Who leads | Screen | Warren |
|---|---|---|---|
| **Reading** (no conversation) | Banker | Everything, meeting points included | Not present |
| **Guided** | Warren | Focused on the current point; the rest folded | Leads point by point |
| **Listening** | Banker | Everything, as in Reading | Answers and records when asked |

The start card offers both: **Walk me through it** (primary) and **I'll look myself — just
listen**. A switch in Warren's panel changes mode during the conversation; so do "let me
look" and "carry on" by voice.

## 4. Guided mode

### The agenda

The review is a list of **steps**, built from the open meeting points and shown in Warren's
panel in place of the plain list of points.

1. **Briefing.** Fifteen seconds: who the client is, two or three key figures, how many points
   there are and how they split. "Shall we start?"
2. **Wealth points.**
3. **Family points.**
4. **If the client died today.** Warren turns the simulation on, shows in Wealth how much the
   estate shrinks and goes through each cost of inaction, then shows in Family who would
   receive what and which heirs pay more because of where they live. If the rules find no
   cost, one sentence and on to the next step.
5. **General points**, then **closing**: one sentence of summary and on to the report.

Rules for building it:

- One step per subject: points about the same item are merged into one step.
- Within a section: what does not add up first (inconsistent, to verify), then what is
  missing, largest amounts first, then topics.
- The simulation comes after wealth and family because it depends on them: the more complete
  the data, the more it can be trusted.
- The agenda is live. An answer that closes a point removes its step; an answer that opens a
  new point inserts a step right after the current one. The count ("3 of 7") follows.

### One step

Each step has a title, the sentence Warren says, and the item it is about. **What Warren says
is what the card shows**: the voice and the screen never diverge.

Three ways out of a step, by voice or with a button:

| Outcome | Said as | Effect |
|---|---|---|
| **Answered** | The banker gives the information | Warren records it; the point closes by itself |
| **For the meeting** | "I don't know", "I'll ask her" | The point stays open and goes to the report |
| **Not relevant** | "Skip that", "not relevant" | The point is dismissed |

Also: **Back** (previous step), and jumping to any step by clicking it in the agenda.

Warren keeps to the step. If the banker brings up something else, Warren records it, says so
in a few words, and returns to the step. It does not open new subjects of its own in this mode.

### The screen

- A **Now card** at the top of the workspace: progress ("3 of 7"), the step's title and
  sentence, and the outcome buttons.
- Below it, **only the section the step is about stays open**, with the item highlighted. The
  other sections of the view are folded to one line each, with their title and total, and can
  be opened by hand.
- The view changes by itself when the step is in another stage. During the simulation step
  the scenario switch is on.
- The stepper and the meeting points remain, but in this mode they navigate the agenda: a
  click takes the review there, Warren included.

## 5. Listening mode

The screen shows everything. Warren:

- does not greet with questions and does not walk through gaps;
- acts on requests ("make the Mallorca apartment six million", "drop that point", "what if she
  died tomorrow?") and confirms in a few words, with the change highlighted on screen;
- speaks up unprompted only when what it is told contradicts what is recorded.

## 6. Interrupting and resuming

**In the same conversation.** "Let me look" (or the switch) pauses the review: the screen
unfolds, Warren goes quiet, the agenda keeps its place. "Carry on" resumes at the same step,
with one sentence of recap: "We were on the mortgage with no property behind it."

**In a later conversation.** The session is saved as it goes: what was recorded, the state of
every meeting point, the mode and the position in the agenda. Reopening the client shows it as
it was left, and the start card reads **Resume — point 4 of 7**, with **Start over** beside
it. On resuming, Warren says where the review stands instead of the briefing. Start over
discards the saved session and goes back to the client's file.

What counts as done is not replayed: steps already answered, kept for the meeting or dismissed
stay that way.

## 7. Design

### State (added to the session state)

```
mode          guided | listening
agenda[]      id, kind(briefing|point|simulation|closing), section, title, say,
              pointIds[], itemId, status(pending|current|done), outcome
currentStepId
```

The agenda is derived from the meeting points by a pure function (`src/agenda.py`), rebuilt
after every change like the checks, keeping the outcome of steps already done.

### Agent

- **Guided**: the stage agents remain, but their instructions carry only the current step, the
  item it is about, and the guidance for its section, instead of the whole file and every
  point. Instructions are replaced when the step changes. New tools: `finish_step(outcome)`,
  `previous_step()`, `go_to_step(id)`, `pause_review()`.
- **Listening**: one agent with the full picture, as today, with instructions not to lead.
- Smaller instructions per turn should also make tool use more reliable; several of the
  failures seen in testing came from the size of the context.

### Saving the session, and the points before the conversation

Both needs have the same answer: **the agent writes the session state to a store after every
change, and the page reads it**.

- A `SessionStore` interface with one implementation for now: a JSON file per client under
  `data/sessions/` (git-ignored).
- A command, `uv run python src/seed.py`, computes the initial state of every client, meeting
  points and simulation included, and writes it. The page then has the points without a
  conversation, and the simulation switch works before the conversation too.
- The page reads the saved state on load and falls back to the client file when there is none.

Limit to decide on: a file store works when the agent and the frontend share a disk, as they
do locally. **Deployed as two services** (Railway), they do not, and the store has to be a
database or a shared volume. The interface allows it; the implementation is not in this plan.

## 8. Tests

- `agenda`: order, merging by item, insertion and removal as points open and close, outcomes
  kept across rebuilds, position kept across a save and a load.
- Agent, in-process: stays on the step; records an answer and moves on; "I don't know" keeps
  the point and moves on; "not relevant" dismisses; "let me look" pauses and "carry on" resumes
  at the same step; resumes from a saved session without the briefing; in listening mode does
  not ask questions unprompted.
- Browser walk-through: a full guided review of one rich and one sparse client, an
  interruption and a resume, and a resume after leaving the page.

## 9. Plan

1. **Session store and seed.** Save on every change, load on start, seed command, page reads
   the saved state. Points and simulation visible before the conversation. Start over.
2. **Agenda.** Pure function, state fields, tests.
3. **Agent.** Modes, step-scoped instructions, step tools, resume wording, tests.
4. **Screen.** Two-button start card with resume, Now card, folding sections, agenda panel,
   mode switch.
5. **Walk-through** and documentation.

## 10. Open decisions

- Storage when deployed: database or shared volume (see section 7).
- Whether a saved session expires, for example after the meeting date or after some days.
- Whether "Start over" should ask for confirmation when a lot has been recorded.

## 11. As implemented

Decisions on the open points: saved sessions do not expire; **Start over** does not ask for
confirmation; storage is the local file store only.

Differences from the proposal:

- **Instructions are scoped to the stage, not to the step.** The agent in charge still carries
  the data of its stage; what changes with each step is delivered in the tool result ("That
  step is done. Current step, 3 of 11: ...") and, when the banker moves the review by hand, in
  the instruction for the next thing Warren says. This kept one agent per stage and avoided a
  reconnection to the voice model at every step. The whole-file context is therefore not
  smaller than before; the gain in reliability expected from smaller instructions is not there.
- **The card shows the point, Warren asks about it.** The card carries the title and the text
  of the meeting point; Warren puts it as a question in its own words. Same subject, not the
  same sentence.
- **A step whose points close is finished without being asked.** When what the banker says
  closes every point of the current step, the step is marked answered and the review moves on.
- **Steps are kept once seen or closed**, so the count does not shrink as points close; a point
  opened by an answer adds a step in its section, which may be before the current one. The
  review then returns to it after the steps that follow.
- **Going back** skips steps that have nothing left to discuss.
- **A click on the stepper** in a guided review goes to the first step still to do in that
  stage.
- **Reaching the report ends the review**: the closing step finishes by itself.
- **Mode switch labels** are "Guide me" and "I'll look".

Where things live: `src/agenda.py` (steps), `src/sessions.py` (file store), `src/seed.py`
(starting sessions), the review methods of `PrepStore`, `GUIDED` / `LISTENING` / `step_brief`
in `src/prompts.py`, `finish_step` / `previous_step` / `set_mode` in `src/stages.py`, and on
the screen `frontend/components/prep/review.tsx` (Now card, agenda) and the folding in
`wealth-view.tsx`.

Not done: storage for a deployment where the agent and the frontend do not share a disk; the
browser walk-through covered one client (Henrik Larsson), not the two planned.

## 12. Changes after the first walk-through (4 October 2026)

Asked for by the user after trying the guided review.

**The list and the preparation agree.** The CRM's free-standing "assets outside the bank"
figure is gone. Both AuM columns of the client list are the sum of the recorded positions, as
on the balance sheet. Every mock client now holds more than CHF 3m at the bank and six of the
eight have positions with other banks.

**Activity notes explain the discrepancies.** Each client has free-text activity notes, the
kind a banker writes in the CRM after a contact. The screen shows the CRM's structured fields;
when a note says something the fields do not carry, a meeting point says so and names the
note: "Activity note of 12 May 2026: it mentions about CHF 4 million held with Julius Baer.
This is not in the structured fields of the CRM." In the guided review the card quotes the
note, Warren asks whether it is still right and whether to record it, and the point closes once
the structured data carries it. The notes are listed under the wealth and family views.

- The facts a note contains are **tagged by hand in the mock data** (`facts` with an `expect`
  block that `checks._reflected` tests against the structured data). Nothing reads the free
  text. Extracting the facts with a model is the natural next step and is not done.
- Facts from one note are discussed in one step per group (wealth, family).

**The agenda is grouped.** Start, Wealth, Family, General, If the client died today, Finish:
each a block in Warren's panel with its own count and progress bar. What the current step is
about stays highlighted on screen for as long as the step lasts.

**The simulation is offered, not imposed.** After the wealth, family and general points comes
a step that proposes it, shown on today's balance sheet. Accepted, the balance sheet turns
into the simulation there and then (the tax blocks appear, the headline counts down to what
would reach the heirs), Warren goes through each cost, then the family view shows who would
receive what. Declined, every simulation step is skipped and the review goes to the report;
the costs of inaction stay open and still appear in the report.

## 13. Keeping the voice and the screen together (4 October 2026)

The user reported Warren talking about points the screen was not showing, and the passage
from wealth to family going unnoticed. Four causes were found and addressed.

- **Warren saw more than the step.** In a guided review its instructions no longer contain the
  other open points, the activity notes, the simulation or the bank's list of "situations that
  deserve a question". They keep the recorded data of the stage, which recording needs. The
  step arrives with each tool result and each time Warren is asked to speak. This replaces the
  first point of section 11: the instructions are now smaller in guided mode (about 9,000
  characters against 15,000).
- **The item was not on screen.** Each step now names what it lights up (`targetIds`): its
  item, every asset a tax rule hits, the income and expense lines behind a deficit, the note.
  The workspace scrolls to the first of them and the Now card stays pinned at the top.
- **One step per turn.** Warren sometimes closed the step it had just been given before the
  banker heard it. `finish_step` now refuses a second move in the same turn.
- **A change of section is announced.** When the review moves forward into another group,
  Warren is given the exact opening words ("That completes the wealth: 3 points kept for the
  meeting. We now move on to the family. The family tree is on your screen."), a bar appears
  between the header and the workspace ("Wealth -> Family"), the stage in the header pulses and
  the new view slides in. Exact words, because an announcement left to the model was sometimes
  skipped.

A test walks part of a review and has a judge model check, turn by turn, that what Warren says
is about the step on screen, and that the section change is announced
(`test_each_reply_is_about_the_step_on_screen_and_sections_are_announced`).

Not solved: Warren can still say it is moving on without calling the tool, in which case the
screen stays behind. Nothing detects it; the scoped instructions make it less likely.

## 14. The report builds on screen

- Figures and the experts to invite are computed without the model and appear at once; the
  key figures count up from zero and the bars grow.
- A row of four marks (figures, experts, summary, conversation openers) ticks off as each part
  is really there.
- The summary appears as the model writes it. This needed the report model to run with
  thinking level `low`: by default it stayed silent for 10 to 20 seconds and then delivered
  everything at once; at `low` the text starts within a second and the whole report takes
  about 3 seconds. A model that does not accept a thinking level falls back to its default.
- Meeting points are cards, two to a row, arriving one after the other, each with its opener
  set off as a quotation.
- The header is a meeting card: client, four figures, a bar showing how much of the estate
  taxes on death would take, and the balance-sheet towers in small.

## 15. Confirmed moves, dictated points and languages (4 October 2026)

**Nothing is listed before the conversation.** Opening a client shows the wealth and the family,
and no list of points: Warren's panel only offers to start. The review agenda appears once the
banker is talking to Warren; the plain list of meeting points is there in listening mode, after
a conversation has taken place, and when the review is complete. This replaces state 1 of
section 3, where the points were readable before talking.

**The screen moves only once the banker agrees.** Section 13 had Warren announce a change of
part while the screen changed. Now the change is a step of its own, a *gate*:

- `enter-family`, at the end of the wealth points: "That completes the wealth: 3 points kept
  for the meeting. Next comes the family." Asked on the wealth screen.
- the simulation offer, asked on the screen in place rather than on the balance sheet.
- `enter-report`, once everything else is done. Asked on the screen the review ended on.

Warren says the part is finished and asks whether to move on. The stage on screen changes when
the gate is closed, by voice or with its button, and the first step after it starts with one
sentence saying where the review now is.

**The report waits for every point.** In a guided review the report cannot be reached while a
step is pending, whichever way it is asked for: `next_pending` never returns a report step
while another is open, `set_stage("report")` is refused, and `go_to_stage` is not among the
guided tools. If the banker asks for the report early, Warren says how many points are left
and asks whether to keep them for the meeting; `finish_remaining` then closes them as kept and
goes to the `enter-report` gate. A point reopened by a later change is gone back to first.
In a guided review the stepper in the header sends the request to Warren and the screen
follows the answer; it no longer switches the view on its own.

**A point the banker dictates is taken at once.** "Note this for the meeting: ..." is recorded
with `add_meeting_point`, with one question at most if it is unclear. Its step in the agenda is
created already done, kept for the meeting and marked "Noted by you", so the review never asks
about it; it reaches the report like any other point.

**Warren records nothing when nobody answered.** A button on the step card closes the step
without the banker saying anything. Warren used to act on its own question at that moment: it
recorded the boat of an activity note the banker had only marked "Ask the client". Two things
prevent it. The instruction given after a button says how the step was closed and that nothing
was confirmed (`after_button`). And every speech Warren makes of its own (at the start, after a
button, on taking over a stage) goes through `speak_unprompted`; a tool that changes the
session refuses to run within such a speech. The instruction alone was not enough: the test
failed about one run in four without the guard.

**Languages.** The start card offers English, Français and Español. The choice is kept in the
browser and sent in the dispatch metadata (`language`); it is saved with the session. It sets
the language Warren speaks (instructions and the voice model's language code) and the
language of the report's summary and conversation openers. The screen, the step titles and
the rule-based wording of the points stay in English.

Tests: `test_family_comes_up_only_once_the_banker_agrees`,
`test_a_point_the_banker_dictates_is_noted_and_not_asked_again`,
`test_report_is_not_reached_while_points_remain`, `test_speaks_french_when_asked_to`,
`test_a_step_closed_with_a_button_is_not_recorded_by_warren`, and their store-level
counterparts in `tests/test_agenda.py`.

Not solved: within one answer of the banker, Warren can still close a step and then act on the
next one without asking. And the live checks were made by typing; with a microphone that picks
up noise, Warren may take the noise for an answer.
