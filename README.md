# Warren — client meeting preparation

Warren is a voice assistant that helps a private banker prepare a client meeting. The banker
picks a client, talks to Warren, and together they review the client's wealth and family
situation. The result is a list of **meeting points**: what to raise or ask in the meeting,
worded so it is easy to bring up in conversation.

The banker speaks; the screen shows. Everything Warren records appears live on screen.

- `src/` — the agent, built with [LiveKit Agents for Python](https://github.com/livekit/agents)
  on the Gemini Live API.
- `frontend/` — the web app (Next.js), built on the LiveKit agent starter.
- `data/` — mock clients and settings, read by both.
- `knowledge/` — the guidance Warren follows, as Markdown the bank can edit.
- `rules/` — the tax rules behind the cost-of-inaction simulation (illustrative).
- `docs/meeting-prep-design.md` — spec, design and plan.

## How a session works

Opening a client shows the wealth and the family as the bank knows them, without a
conversation and without any list of points: those come up while talking to Warren. The
banker picks the language Warren speaks (English, French or Spanish; the screen stays in
English) and starts Warren in one of two ways:

- **Walk me through it** — a guided review. Warren leads, one point at a time; a card on
  screen shows the current point, the part of the screen it is about stays open and the rest
  folds. The steps are grouped (wealth, family, general, simulation) in Warren's panel.
  Each point ends one of three ways, by voice or with a button: the banker gives the
  answer, keeps it for the meeting, or says it is not relevant. Before moving from the
  wealth to the family, and before the report, Warren says the part is finished and asks;
  the screen changes once the banker agrees. The report comes only when every point has
  been gone through or kept for the meeting. A point the banker dictates ("note that the
  children should be invited") is recorded at once and not asked about again. After the wealth and family
  points Warren offers to simulate the client's death; accepted, the balance sheet turns into
  the simulation on screen, then the family view shows who would receive what.
- **I'll look myself — just listen** — the banker reads and Warren acts only when asked.

The banker can switch between the two at any time ("let me look", "carry on"). The session
is saved as it goes: an interrupted review resumes at the same point, in the same
conversation or after leaving the page. **Start over** discards it. See
`docs/guided-review-spec.md`.

The page has three stages:

1. **Client list** (`/`). One row per client; **Prepare meeting** opens the client's page.
   The banker starts the conversation with Warren from there, when ready.
2. **Wealth.** Two sections, each with a **Visual | Table** switch: the balance sheet and
   income and expenses. Visual shows two 3D towers of equal height (assets | debt and net
   worth; income | expenses and surplus, or the shortfall funded from capital) with every item
   listed beside them. Table shows the T-account with full details, and its tab counts the
   items that are incomplete. Pension plans sit below, off balance sheet.
3. **Family.** A family tree: the client, partner and former partners, children. Cards are
   marked when someone lives abroad, is a minor, or has details missing; a new family member
   grows into the tree when Warren records it.
4. **Report.** A summary, key figures, and each meeting point with a conversation opener.

When Warren records something, the row flashes, the block resizes and the totals count to
their new value. When Warren mentions something that is on screen, it lights up: the frontend
matches the words of Warren's live transcript against the items shown
(`frontend/hooks/useSpokenFocus.ts`), so this costs the agent nothing.

An item and the meeting points about it light up together: hover a person, a row or a block
to see its points, hover a point to see what it is about, click a point to go to its section.

**Cost of inaction.** A switch above the workspace, **Today | If the client died today**,
shows what the client's death would cost and who would receive what: in Wealth, the taxes
each asset would trigger and what would reach the heirs; in Family, each heir's share, tax
and net, and how much of the assets held at the bank would pass to heirs abroad. Warren
turns it on when asked ("what if she died tomorrow?"). Each cost becomes a meeting point
that names the bank expert to involve, and the report lists the experts to invite. The
figures come from `rules/succession.yaml` through `src/succession.py`, never from the
model. **The rules shipped here are illustrative and have not been reviewed by a tax
professional**; the screen says so. See `docs/cost-of-inaction-spec.md`.

The banker can move between stages by voice or with the stepper, type instead of speaking,
turn on the camera, or share the screen.

## Run it

You need a [LiveKit Cloud](https://cloud.livekit.io/) project and a Google Gemini API key.

**Agent.** Copy `.env.example` to `.env.local` and set `LIVEKIT_URL`, `LIVEKIT_API_KEY`,
`LIVEKIT_API_SECRET` and `GOOGLE_API_KEY`. Then:

```console
uv sync
uv run python src/agent.py dev
```

**Frontend.** In `frontend/`, copy `.env.example` to `.env.local`, set the same three LiveKit
values and `AGENT_NAME` to the agent's name. Then:

```console
pnpm install
pnpm dev
```

Open http://localhost:3000.

**Seed the sessions** once, and again after changing `data/clients.json`, the rules or the
checks, so that the simulation is available, and a review can be resumed, before any conversation:

```console
uv run python src/seed.py           # keeps sessions in progress
uv run python src/seed.py --force   # resets every client
```

Sessions are saved as files under `data/sessions/` (git-ignored). This needs the agent and
the frontend to share a disk, as they do locally; deployed as two services they do not, and
the store in `src/sessions.py` has to be replaced by a database.

**Agent name.** The agent registers under `AGENT_NAME` (default `warren-prep`) and the
frontend dispatches sessions to its own `AGENT_NAME`; the two must match. Workers that share
a name share the sessions, so give each environment its own: for example `warren-prep` for
the deployed pair and `warren-dev` in both local `.env.local` files.

`uv run python src/agent.py console` talks to the agent in the terminal, without the
frontend. It prepares the client named in `WARREN_DEFAULT_CLIENT` (default `c-001`).

## How it is built

**The agent owns the state.** A session's state (`PrepState` in `src/models.py`) lives in a
`PrepStore`. Tools are the only way to change it. After every change the agent sends the whole
state to the frontend on the `warren.state` text stream; the frontend renders the newest
revision and highlights what changed. The frontend calls two RPC methods on the agent:
`warren.request_state` and `warren.set_stage`. The client to prepare travels as dispatch
metadata (`{"clientId": "c-001", "mode": "guided", "language": "fr"}`).

**One agent per stage** (`src/stages.py`): `WealthAgent`, `FamilyAgent`, `ReportAgent`, with
handoffs between them. Each carries only its own instructions, guidance file and tools.

**Two layers of rules.**

- `knowledge/wealth.md`, `family.md`, `report.md` are loaded into the agent's instructions:
  what to capture, which situations deserve a question, what never to say. Edit them freely.
- `src/checks.py` runs after every change and computes findings that must not depend on the
  model: missing fields, arithmetic mismatches, implausible dates. Each finding becomes a
  meeting point, closes when the data fixes it, and reopens if the problem returns.

**Activity notes.** The screen shows the structured fields of the CRM. Each client also has
free-text activity notes (`activityNotes` in `data/clients.json`). When a note says something
the fields do not carry, a meeting point names the note, and Warren asks whether to record
it. In this demo the facts a note contains are tagged by hand in the mock data; nothing
reads the free text.

**The report** (`src/report.py`) computes all figures in code. A text model (Gemini Flash,
`WARREN_REPORT_MODEL` to change it) writes the summary and the conversation openers; the
summary is shown as it is written and the report builds on screen in about three seconds. If it
fails, the report still shows the figures and the raw points.

**Mock data.** `data/clients.json` holds eight clients with deliberately uneven data.
`data/settings.json` holds the house bank, base currency and FX rates. Session changes are saved
under `data/sessions/`; **Start over** goes back to the file.

## Tests

```console
uv run pytest
```

- `tests/test_agenda.py` — the guided review: order of the steps, moving through them,
  saving and resuming. Fast, no network.
- `tests/test_agent_guided.py` — the agents in guided and listening mode; calls the voice model.
- `tests/test_succession.py` — the succession engine on the mock clients and on small
  rule sets. Fast, no network.
- `tests/test_agent_succession.py` — the agents and the simulation; calls the voice model.
- `tests/test_store.py`, `tests/test_checks.py` — the store and every check, including what
  each mock client must trigger. Fast, no network.
- `tests/test_report.py` — report assembly; one test calls the text model.
- `tests/test_agent.py` — the stage agents, run in-process against the production voice
  model. About four minutes; needs `GOOGLE_API_KEY`.

`scenarios.yaml` holds full-conversation simulations: `lk agent simulate --scenarios scenarios.yaml`.

Formatting and linting: `uv run ruff format` and `uv run ruff check`; in `frontend/`,
`pnpm format` and `pnpm lint`.

## Limits of this version

- Mock data only: no CRM or core-banking integration, no authentication. The token endpoint
  in `frontend/app/api/token` is for development only.
- Figures change through the agent, not by typing into the screen.
- Warren frames topics and questions. It does not recommend products or give tax or legal
  conclusions.

## License

MIT — see [LICENSE](LICENSE).
