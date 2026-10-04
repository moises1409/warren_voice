# Warren — Client Meeting Preparation

Spec, design and implementation plan · 3 October 2026 · Status: **implemented** (branch `meeting-prep`), steps 0–6 done

---

## 1. Product spec

### 1.1 Goal

A web app for private bankers that helps them prepare a client meeting. The banker picks a
client, talks to a voice agent ("Warren"), and together they review the client's wealth and
family situation. The outcome is a list of **meeting points**: everything the banker needs to
raise or ask in the meeting, phrased so it is easy to bring up in conversation.

Interaction model (from the use-case note): **voice in, screen out**. The banker speaks; dense
information lives on screen and updates live. The screen is self-sufficient; the agent's voice is
short and conversational.

UI language: English. Default currency: CHF.

### 1.2 Screens

**A. Client list (home, `/`)** — one row per client:

| Column | Notes |
|---|---|
| Client name | |
| Age | derived from date of birth |
| Domicile | city, country |
| Segment | Entrepreneur · Independent · Privatier · Top Executive |
| AuM at bank | CHF; sum of the client's positions booked at the house bank |
| AuM outside bank | CHF; figure declared in CRM |
| Performance | % YTD, signed, coloured |
| Last contact | date |
| Risk scoring | High · Medium · Low (badge) |
| — | **Prepare meeting** button |

**B. Preparation session (`/prepare/[clientId]`)** — opens the conversational agent with
microphone mute, camera, screen share, chat/transcript and leave controls. A stepper shows the
three stages; the workspace shows the stage's live view.

1. **Wealth** — a T-account view:
   - Balance sheet: **Assets** (left; bankable, then non-bankable) | **Liabilities** (right; plus net worth)
   - Cash flow: **Income** (left) | **Expenses** (right), each split recurring / one-off
   - **Off balance sheet** strip at the bottom: pension plans
2. **Family** — a family tree: client linked to spouse/partner, children underneath, with
   marital status, ages, residence and notes.
3. **Report** — generated summary of the situation plus the meeting points, grouped and worded
   as conversation openers.

The view shows the current known state as soon as the stage opens. Every fact the banker gives
the agent updates the view live, and the changed item is briefly highlighted.

**Meeting points panel** — visible in all stages. Each point has a kind (missing information,
inconsistency, plausibility, topic to raise), the section it belongs to, and a status.

### 1.3 What the agent does

- Guides the banker through Wealth → Family → Report, one question at a time, starting from the
  gaps in what is already known. The banker can jump between stages by voice or by clicking the stepper.
- Captures:
  - **Assets**: amount, currency, asset type, country, bankable or not, and custodian bank if bankable.
  - **Debt** (mortgages, personal loans, Lombard loans…): amount, currency, bank, country.
  - **Pension plans** (off balance sheet).
  - **Income**: recurring, or one-off with a date (bonus, dividend, inheritance, gift).
  - **Expenses**: recurring or one-off.
  - **Family**: marital status; children with age and residence; other relevant facts.
- Warns when relevant information is missing, inconsistent or implausible, and records each case
  as a meeting point to ask the client.
- Reads its domain knowledge and rules from Markdown files that the bank can edit without touching code.

### 1.4 Mock data

About eight invented clients covering all four segments and all three risk levels, with
deliberately uneven data quality: two rich dossiers, three average, three sparse. Each one is
seeded with at least one situation the rules should catch, for example:

- CRM declares CHF 4m outside the bank but no external position is detailed
- a mortgage with no real estate on the asset side
- recurring expenses above recurring income with no explanation
- married, no information on the spouse; children with unknown residence
- a child resident in the US (flag: cross-border / tax topic)
- an expected inheritance with no date; age 58 with no pension plan recorded
- an asset with no currency or no country

### 1.5 Non-goals for this version

- No real CRM / core-banking integration, no authentication.
- No manual editing of figures in the UI: changes go through the agent (voice or chat).
- No life-goals axis and no client-facing mode (both in the use-case note; later).
- No product recommendations. The agent frames **topics and questions**, never advice.

---

## 2. Design

### 2.1 Architecture

```
 Next.js frontend                         LiveKit room                    Python agent
 ────────────────                         ────────────                    ────────────
 /                 client list  ◄── reads data/clients.json ──►  loads client by id
 /prepare/[id]     session UI   ── token + dispatch metadata {clientId} ──►  entrypoint
                   workspace    ◄── text stream "warren.state" (full snapshot) ──  PrepStore
                   stepper      ── RPC "warren.set_stage" / "warren.request_state" ─►
                   controls     ◄──────────── audio / video / transcript ────────────►
```

Decisions:

1. **The agent owns the session state.** One `PrepState` object (dossier + meeting points +
   stage + report) lives in `session.userdata`. Tools are the only way to change it.
2. **Full snapshots, not patches.** After every mutation the agent sends the whole state as JSON
   on a text stream (topic `warren.state`) with an increasing `rev`. Text streams have no size
   limit (RPC payloads cap at 15 KiB), snapshots are idempotent, and the frontend finds what
   changed by diffing item ids to drive the highlight. State is a few KB, so cost is negligible.
3. **Frontend → agent via RPC**: `warren.set_stage` (stepper click) and `warren.request_state`
   (frontend asks for a re-send on mount/reconnect, since streams are not replayed).
4. **Instant first paint.** The session page loads the same mock dossier server-side and renders
   it before the agent connects; agent snapshots then take over.
5. **Client selection travels as dispatch metadata** (`agentMetadata: {"clientId": …}` on
   `useSession`), read from `ctx.job.metadata`. The agent stays explicitly dispatched.
6. **One shared data folder** at repo root (`warren/data/`), read by both sides. It is inside the
   agent's Docker build context; the frontend reads it server-side.

### 2.2 Agent design

Three agents with handoffs, sharing `userdata`. This follows the project's AGENTS.md guidance:
each stage gets only its own instructions, rules file and tools, which keeps the realtime
model's context small and tool choice reliable.

| Agent | Instructions include | Stage tools |
|---|---|---|
| `WealthAgent` | `knowledge/wealth.md` + current wealth state + open findings | `upsert_asset`, `upsert_liability`, `upsert_pension`, `upsert_cash_flow`, `remove_item` |
| `FamilyAgent` | `knowledge/family.md` + current family state + open findings | `set_marital_status`, `upsert_family_member`, `remove_family_member` |
| `ReportAgent` | `knowledge/report.md` + summary of state | `generate_report` |

Shared tools on all three: `add_meeting_point`, `update_meeting_point` (edit / resolve / dismiss),
`go_to_stage` (performs the handoff; also invoked by the stepper RPC).

Tool behaviour:

- `upsert_*` take an optional `id`; without it they create. Every field except the type is
  optional, so partial knowledge is stored instead of rejected. Each tool returns a short
  confirmation plus the findings that changed, so the agent can react in the same turn.
- Tools are fast and synchronous. Gemini 3.1 Live has no asynchronous function calling: the
  model waits for the tool result, so nothing slow may run inside a tool.
- `generate_report` returns immediately and runs generation as a background task; the report
  arrives on screen through the normal state snapshot.

**Rules: two layers.**

- *Markdown knowledge* (`knowledge/*.md`), loaded into the stage agent's instructions. Editable
  by the bank. Holds what to capture per asset type, which country/asset combinations deserve a
  question, how to phrase questions, and what never to say (advice guardrail).
- *Deterministic checks* (`checks.py`), run after every mutation. They compute **findings**
  that must not depend on the model remembering: missing mandatory fields, arithmetic
  mismatches (declared external AuM vs detailed positions), liabilities without a matching
  asset, expenses above income, age-based checks, stale last contact. Findings become meeting
  points automatically (source `rule`) and close automatically when the data fixes them.

Meeting points therefore have three sources — `rule`, `agent`, `banker` — and one list.

**Report generation.** Figures (totals, net worth, allocation by country/currency/type) are
computed in code. A text LLM call turns state + open meeting points into a short narrative and
rewrites each point as a conversation opener, returned as structured JSON. The voice model is not
used for this: long structured output through a realtime tool call is slow and error-prone.

**Model.** Keep `gemini-3.1-flash-live-preview` (voice, camera and screen-share input). The LLM
becomes injectable in the agent constructors so tests can run the same agents on a text model.

### 2.3 Data model

```
Client      id, name, dateOfBirth, domicile{city,country}, segment, riskScore,
            performanceYtdPct, lastContact, aumExternalDeclared
Asset       id, bankable, type, label, amount, currency, country, bank
Liability   id, type, label, amount, currency, country, bank, securedByAssetId
Pension     id, type, provider, amount, currency, country
CashFlow    id, direction(income|expense), frequency(recurring|one_off), type, label,
            amount, currency, date            # recurring amounts are per year
Family      maritalStatus, members[]: id, relation, name, birthYear, residence{city,country},
            otherParentId, notes
MeetingPoint id, section(wealth|family|general), kind(missing|inconsistency|plausibility|topic),
            text, source(rule|agent|banker), status(open|resolved|dismissed), relatedItemId
PrepState   rev, clientId, stage, client, assets[], liabilities[], pensions[], cashFlows[],
            family, meetingPoints[], report|null
```

- Any field may be null; the UI shows "—" and the checks raise a finding where it matters.
- Amounts keep their original currency; totals convert to CHF with a static table in
  `data/settings.json`. Rows show the original amount and the CHF equivalent.
- "AuM at bank" is derived from bankable assets whose `bank` is the house bank, so the list and
  the balance sheet can never disagree.
- Pydantic models on the agent; mirrored TypeScript types on the frontend.

### 2.4 Frontend design

```
┌──────────────────────────────────────────────────────────────┬──────────────────────┐
│ ← Clients   Elena Brunner · 54 · Zürich · Entrepreneur       │  ◉ Warren (listening) │
│ ① Wealth ──── ② Family ──── ③ Report                         │                      │
├──────────────────────────────┬───────────────────────────────┤  Meeting points (5)  │
│ ASSETS            CHF 12.4m  │ LIABILITIES         CHF 2.1m  │  ! External AuM 4m   │
│  Bankable                    │  Mortgage · UBS · CH   1.8m   │    not detailed      │
│   Equities · Warren · CH 4.2m│  Lombard · Warren · CH 0.3m   │  ? Mortgage without  │
│   …                          │                               │    property          │
│  Non-bankable                │ NET WORTH          CHF 10.3m  │  …                   │
│   Real estate · ES      2.0m │                               ├──────────────────────┤
├──────────────────────────────┼───────────────────────────────┤  Transcript / chat   │
│ INCOME (per year)            │ EXPENSES (per year)           │                      │
│  Recurring / One-off         │  Recurring / One-off          │                      │
├──────────────────────────────┴───────────────────────────────┤                      │
│ OFF BALANCE SHEET · Pension plans                            │ 🎤  📷  🖥  💬  ⏻    │
└──────────────────────────────────────────────────────────────┴──────────────────────┘
```

- New `PrepSessionView` composed from the existing agents-ui pieces (`AgentControlBar`,
  `AgentChatTranscript`, audio visualizer, track tiles). The vendored `agent-session-view-01`
  block is left untouched.
- Workspace components: `BalanceSheet`, `CashFlowSheet`, `OffBalanceStrip`, `FamilyTree`,
  `ReportView`, `MeetingPointsPanel`, `StageStepper`.
- `usePrepState` hook: registers the `warren.state` stream handler, keeps the latest `rev`,
  exposes the state and the set of ids changed in the last snapshot.
- `FamilyTree`: small custom layout (couple row, connector lines, children row; ex-partners
  placed beside with their own children). Two generations is enough here, so no graph library.
- Session lifecycle moves from the app root into the prepare page, keyed by client id.
- Branding: replace the LiveKit header and welcome view with a Warren header; restrained,
  dense, tabular numerals, light and dark themes kept.
- Report view has Copy and Print actions.

### 2.5 Risks and how they are handled

| Risk | Handling |
|---|---|
| Handoffs / instruction updates on Gemini 3.1 Live need `livekit-plugins-google` ≥ 1.8.2; 1.8.1 is installed | **Resolved in Step 0**: bumped to 1.8.4; handoff, shared `userdata` and `on_enter` announcement verified on Gemini 3.1 Live. |
| Misheard amounts or currencies | Agent repeats amount + currency briefly; the value appears highlighted on screen; corrections reuse the item id. |
| Model forgets to flag a gap | Deterministic checks create the finding regardless. |
| Tool latency blocks speech | All tools in-memory; report generation in the background. |
| Agent crosses into advice | Guardrail in every knowledge file and in the report prompt; covered by a simulation scenario. |
| Dispatch metadata not forwarded by the sandbox token server | **Resolved in Step 0**: the frontend uses the included `/api/token` route (no token server id set); metadata verified end to end, as was delivery on the `warren.state` text stream. |

---

## 3. Implementation plan

Each step ends in something that can be run and checked. Agent behaviour is test-first, as
AGENTS.md requires.

**Step 0 — Foundations** ✅ done 3 Oct 2026
- Finding: a stage agent stays silent after a handoff unless its `on_enter` calls `generate_reply`; every stage agent must do so.
- Branch off `main`. Bump `livekit-agents[google]` and `livekit-plugins-google` to ≥ 1.8.2.
- Spike: two trivial agents with a handoff on Gemini 3.1 Live; pass `clientId` as dispatch
  metadata and log it. Decides handoff vs single-agent fallback.

**Step 1 — Data and domain core (Python, no LiveKit)** ✅ done 3 Oct 2026
- `data/clients.json`, `data/settings.json` (house bank, base currency, FX rates),
  `knowledge/{wealth,family,report}.md`.
- `src/models.py` (Pydantic), `src/store.py` (`PrepStore`: load, upsert/remove, rev, snapshot),
  `src/fx.py` (settings + conversion), `src/summary.py` (totals), `src/checks.py`.
- Rule points close themselves when the data fixes them and reopen if the problem returns;
  closing one by hand is stored as a dismissal so the next check run leaves it alone.
- Unit tests: store mutations, CHF totals, every check on a seeded client.

**Step 2 — Agent**
- `src/agents/{wealth,family,report}.py`, shared tools, `go_to_stage` handoff; `agent.py`
  remains the entrypoint: reads metadata, builds the store, registers the RPC methods, publishes snapshots.
- `src/report.py`: computed figures + text-LLM narrative with structured output.
- Tests with the in-process framework on a text LLM: correct tool and arguments for typical
  utterances; a partial fact is stored and produces a finding; correction updates instead of
  duplicating; stage change hands off; no advice given.
- Replace `scenarios.yaml` with meeting-prep scenarios.

**Step 3 — Frontend: client list**
- `lib/clients.ts` (server-side loader + types + CHF formatting), `/` page with the table,
  segment and risk badges, Prepare meeting link. Warren header.

**Step 4 — Frontend: session shell and live state**
- `/prepare/[clientId]` page, session keyed by client, dispatch metadata.
- `PrepSessionView` layout with controls and transcript; `usePrepState`; stepper with RPC.

**Step 5 — Frontend: stage views**
- Balance sheet, cash flow, off-balance strip with change highlight.
- Family tree. Meeting points panel. Report view.

**Step 6 — End-to-end verification**
- `uv run pytest`, `ruff`, `pnpm lint`, `pnpm build`.
- Run agent + frontend locally and walk one rich and one sparse client through all three
  stages in the browser; fix what the walk-through shows.
- Update both READMEs and AGENTS.md (structure, data and knowledge files).

### What changed during implementation

- The stage agents live in one module, `src/stages.py`, with instructions in `src/prompts.py`,
  rather than in an `agents/` package.
- The frontend computes totals itself from the snapshot (`frontend/lib/wealth.ts`, mirroring
  `src/summary.py`) so the list, the first paint and the live view share one code path.
- Clicking a stage in the stepper interrupts Warren and switches at once. A chat message typed
  while a stage change is in progress is retried instead of dropped (found in the browser
  walk-through).
- Numbers and dates are formatted by hand on the frontend: `Intl` output differs between Node
  and browsers and broke hydration.
- `tests` resolve `src/` through `pythonpath` in `pyproject.toml`, independent of the editable
  install.
- The voice model runs with thinking level `low`. At the default `minimal` it skipped the
  recording tool in roughly a third of turns while telling the banker it had recorded (measured:
  6-7 of 10 turns recorded at `minimal`, 10 of 10 at `low`; lowering the temperature did not help).
- The agent's dispatch name is `warren-prep`, not the starter's `my-agent`: another worker in
  the same LiveKit project was registered as `my-agent` and took every other session.
- A typed message waits for a stage change in progress, so the new stage's agent answers it.
- The session no longer starts when the page opens: the banker starts the conversation from a
  card that says Warren is an AI voice assistant and that the microphone will be used.
- The wealth stage has a Visual | Table switch per section (balance sheet; income and
  expenses). Visual is a pair of 3D towers (`frontend/components/prep/towers-3d.tsx`, plain CSS
  3D, no extra dependency) with one block per item and the items listed beside them, so the
  visual view hides nothing; Table is the T-account, and its tab counts incomplete items. Colours are a validated five-colour set, light and dark.
- Items Warren mentions light up on screen. This is done on the frontend by matching the live
  transcript against the labels on screen, rather than with an agent tool: a tool call would
  delay Warren's speech on every mention.
- Not done: the LiveKit Cloud simulations in `scenarios.yaml` are written but were not run.

### File map

```
warren/
  data/clients.json, settings.json           new
  knowledge/wealth.md, family.md, report.md  new
  src/agent.py                               rewritten (entrypoint kept)
  src/models.py, store.py, fx.py, summary.py, checks.py, report.py, prompts.py, stages.py   new
  src/tools.py                               removed (weather example)
  tests/                                     new unit + behaviour tests
  scenarios.yaml                             rewritten
  frontend/app/page.tsx                      client list
  frontend/app/prepare/[clientId]/page.tsx   new
  frontend/app/layout.tsx                    Warren header
  frontend/components/app/*                  app.tsx → session per client; welcome view removed
  frontend/components/prep/*                 new workspace components
  frontend/hooks/usePrepState.ts, lib/clients.ts, lib/types.ts   new
```

### Defaults assumed (change any of them before Step 1)

1. Session results are kept in memory only; reopening a client starts again from the mock data.
2. Figures are edited only through the agent, not by typing in the UI.
3. Agent voice stays English (en-GB).
4. House bank name in the mock data: "Warren & Cie".
