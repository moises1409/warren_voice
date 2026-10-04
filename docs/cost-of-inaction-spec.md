# Warren — Cost of inaction and succession simulation

Spec, design and plan · 4 October 2026 · Status: **implemented** (branch `meeting-prep`); see section 12 for what differs from the proposal

Extends `meeting-prep-design.md`.

---

## 1. Goal

Show the banker what the client's wealth structure would cost if nothing is changed, starting
with one scenario: **the client dies today**. Two views of the same simulation:

- **Wealth — cost of inaction.** The taxes the estate would trigger, by asset and by
  country, and how much the wealth shrinks as a result.
- **Family — who receives what.** How the estate, and the assets held at the bank, would be
  split between the family members, and what each heir would pay depending on where they live.

Every inefficiency becomes a meeting point and names the bank expert worth inviting to the
client meeting (tax and succession planning, relocation, US cross-border).

Examples the feature must catch:

- A Swiss resident who owns real estate in France: France taxes the property on death.
- US shares held directly: US estate tax applies to a non-US holder. A fund domiciled outside
  the US that holds the same shares does not trigger it.
- An heir who lives in a country that taxes what its residents inherit: the heir's share is
  worth less than a sibling's.

## 2. Principles

1. **The model never computes or states a tax figure of its own.** Rules live in a structured
   file owned by the bank's tax experts; a deterministic engine applies them. Warren explains
   the result and proposes the discussion.
2. **Every figure cites its rule**: source, validity date, owner. A rule set has a version, and
   a simulation records the version it used.
3. **Indicative, and labelled so.** Figures are shown as "up to", with the assumptions on
   screen. The screen says "Indicative estimate · not tax advice".
4. **Warren frames topics, not conclusions.** It says an exposure may exist, why, and which
   expert should look at it. It does not tell the banker or the client to restructure or to
   move. When an heir's country of residence raises the tax, Warren raises residence as a
   factor and suggests involving the relocation expert.
5. **Missing inputs are visible.** What the simulation had to assume is listed, and what it
   could not determine becomes a meeting point, as elsewhere in the app.
6. The rules shipped with the demo are **illustrative** and say so on screen. They must be
   replaced by rules validated by the bank before any real use.

## 3. Scope

In: one scenario (death of the client today); tax on death in three layers (section 5);
statutory split between spouse or registered partner and children; liquidity check; meeting
points; report section; visual simulation mode in Wealth and Family.

Out, for now: wills and inheritance contracts beyond recording that one exists; liquidation of
the matrimonial property regime beyond a recorded ownership share; trusts and foundations;
lifetime gifts; scenarios other than death (sale of the business, relocation of the client,
divorce); optimisation or "what if you restructured" comparisons.

## 4. New data

| Where | Field | Why |
|---|---|---|
| Asset | `situs` — the country whose tax law attaches to the asset: the property's location, the instrument's domicile. Distinct from `country`, where it is booked | A US-domiciled share booked in Zurich is US-situs |
| Asset | `holding` — direct, via company, via fund | Direct US shares vs a non-US fund; a French property held directly vs through a company |
| Asset | `clientShare` — share owned by the client, default 100% | Jointly owned family home |
| Client | `nationalities`, `taxResidence`, `usPerson` | Which rules apply to the estate |
| Family | `maritalRegime`; `hasWill` | Assumptions behind the split |
| Family member | residence (exists) | Heir-side taxes |

All optional. Warren asks for the ones the simulation needs; what the banker does not know
becomes a meeting point. In real use `situs` and `holding` for positions at the bank come from
the core banking system.

## 5. Rules and engine

### Rule file (`rules/succession.yaml`, illustrative content)

```yaml
version: 2026-10-demo
status: illustrative        # shown on screen until a validated set replaces it
rules:
  - id: fr-real-estate-non-resident
    layer: situs
    when: { asset_type: real_estate, situs: FR, holding: direct }
    tax:
      country: FR
      per_heir: true
      allowance: { child: 100000, spouse: exempt }
      schedule: fr_direct_line        # progressive, top band 45%
    expert: tax_succession
    topic: French property held directly by a non-resident
    source: "..."
    valid_from: 2026-01-01
```

Three layers, evaluated for each asset and each heir:

1. **Estate layer** — the deceased's domicile (Swiss canton: spouse and descendants exempt in
   most cantons; unmarried partner taxed).
2. **Situs layer** — where the asset is taxed regardless of residence (French or Spanish real
   estate, US-situs securities and property, UK-situs assets).
3. **Heir layer** — the heir's country of residence, where that country taxes what its
   residents inherit.

Where two layers hit the same asset and heir, the engine takes the higher amount rather than
the sum (a stated simplification standing in for treaty relief; configurable per rule pair).

### Engine (`src/succession.py`, pure functions, no model)

1. Estate = the client's share of assets minus liabilities. Pension plans are listed
   separately: they follow their own beneficiary rules.
2. Heirs and shares from the statutory rule: spouse or registered partner one half, children
   the other half in equal parts; children everything if there is no spouse. Cohabiting
   partners and former spouses receive nothing and are shown as such. Any other family shape is
   reported as "not modelled" and becomes a meeting point.
3. Each heir receives their share of every asset (pro rata).
4. Apply the rules; produce low and high amounts where a rule or a missing input gives a range.
5. Liquidity: taxes due against liquid assets (bankable, not pledged).

Result, stored in the session state and sent to the screen like everything else:

```
Simulation  scenario, rulesVersion, illustrative, assumptions[], missingInputs[]
            estate, costLow, costHigh, netToHeirs, liquidAssets, liquidityGap
            taxes[]:  ruleId, layer, country, assetId, heirId, base, low, high, expert, source
            heirs[]:  memberId, sharePct, gross, tax, net, aumAtBank
            excluded[]: memberId, reason
```

The engine runs after every change, like the checks. Its findings exist whether or not the
simulation is on screen.

## 6. On screen

One switch in the workspace header, shared by both stages: **Today | If the client died today**.

**Wealth.** The left tower stays the assets. The right tower changes from "Financed by" to
"Where it goes": debts, taxes (one block per country), net to the heirs. The headline counts
down from today's net worth to what reaches the heirs, with the difference named: "Estimated
cost of inaction: up to CHF X (Y% of the estate)". Asset blocks and rows that trigger a tax are
marked; hovering one shows the rule, the base and the source. A liquidity line compares the tax
bill with liquid assets. The Table view lists each tax: asset, country, rule, amount, expert.

**Family.** Each card shows what the person would receive: share, gross, tax, net, and the part
that is assets held at the bank. Cards of heirs whose country of residence adds tax are marked,
with the amount and the rule. People with no statutory entitlement are shown as such. A summary
line gives the share of the bank's assets that would pass to people who are not clients or who
live abroad.

Both views show the assumptions and "Indicative estimate · not tax advice · illustrative rules".

## 7. Warren

- New shared tools: `run_simulation(scenario)` and `end_simulation()`; the header switch calls
  the same through an RPC method. Warren can be asked "what happens if she dies tomorrow?".
- New recording tools or fields for the data in section 4.
- `knowledge/succession.md`: how to talk about it. Figures only as read from the simulation
  result, always "up to" and "indicative"; never a recommendation to sell, restructure or move;
  always the expert to involve.
- Tests first, as for the other stages: the engine against each mock client; the agent turning
  the simulation on when asked, quoting only figures present in the result, naming the expert,
  and declining to recommend a restructuring or a move.

## 8. Meeting points and report

- New point kind `inefficiency`, shown as "Cost of inaction", one per rule that fires, with the
  amount and the expert.
- Report: a "Cost of inaction" section (table of taxes, total, liquidity), the split between
  heirs, and **Experts to invite** with the reason for each. Conversation openers stay questions
  about the client's wishes and plans.

## 9. Demo rule set

Domicile Switzerland; situs rules for France, Spain, the United States and the United Kingdom;
heir rules for France and Spain. This fits the mock clients (Mallorca, Marbella, Miami, US
shares, London accounts, heirs in Madrid, London, Boston and Miami). One mock client gains a
French property to carry the first example.

Two points for the bank's tax team to settle before the rules are written, because they change
which examples fire:

- **Heir-side tax.** As far as we know, France and Spain (and Germany) tax what their residents
  inherit. The United Kingdom and the United States tax the estate and local assets rather than
  the heir, so an heir in London or Boston may add reporting duties but not a higher rate. The
  engine supports both; the rule file decides.
- **US-situs funds.** A fund domiciled in the US is US-situs like a direct share; only funds
  domiciled elsewhere fall outside. The `situs` field carries this.

## 10. Plan

1. **Rules and engine.** Data fields, rule file and loader, `succession.py`, unit tests per
   mock client. No UI.
2. **Findings.** Engine wired into the store; `inefficiency` points; report section and experts.
3. **Agent.** Tools, knowledge file, recording of the new fields, behaviour tests.
4. **Wealth simulation mode.** Header switch, "Where it goes" tower, countdown, tax table.
5. **Family simulation mode.** Amounts and marks on the cards, summary of where the bank's
   assets go.
6. **Walk-through** in the browser with two clients, and documentation.

## 11. Open decisions

- Name and list of the expert roles the bank wants shown.
- Whether the amounts appear in the report the banker may print, or only on screen.
- Whether a cohabiting partner should be shown with the tax they would pay if named in a will
  (a frequent real case) or only as "no statutory entitlement".

## 12. As implemented

Decisions taken on the open points: expert roles are Tax and succession planning, US
cross-border and Relocation (named in the rule file); the amounts appear in the report as well
as on screen; a cohabiting partner is shown as having no statutory entitlement, with a meeting
point asking whether the client has made arrangements.

Differences from the proposal:

- **Client fields left out.** `nationalities`, `taxResidence` and `usPerson` were not added: no
  demo rule uses them, and the client's domicile already stands for the estate layer. Add them
  with the first rule that needs them.
- **No estate-layer rules.** Swiss cantonal tax is treated as nil for spouse and descendants,
  as an assumption shown on screen, not as a rule. The engine has two layers in practice: the
  asset's situs and the heir's residence.
- **The simulation needs the agent.** The figures are computed by the agent and arrive with the
  session state, so the switch is disabled until the conversation with Warren has started. It
  keeps working after the conversation ends, on the last state received.
- **Securities without a recorded domicile** are treated as domiciled where they are booked,
  and the result says so under "not known".
- **Range.** A rule gives a low end through `low_factor`; the screen shows only the high end,
  as "up to".
- **Liquid assets** are bankable cash, equities, bonds, funds and structured products; pledged
  assets are not excluded.

Where things live: `rules/succession.yaml` (rules, experts, assumptions), `src/succession.py`
(engine), `src/checks.py` (`_succession`: findings), `knowledge/succession.md` (how Warren
talks about it), `frontend/components/prep/simulation.tsx` (cost-of-inaction table, note),
and the simulation branches in `wealth-view.tsx` and `family-view.tsx`.

Not done: the rule set has not been reviewed by a tax professional, and the two questions in
section 9 are still open.
