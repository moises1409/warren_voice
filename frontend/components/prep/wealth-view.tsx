'use client';

import { useEffect, useState } from 'react';
import { AnimatedNumber } from '@/components/prep/animated-number';
import { CostOfInaction, taxesByCountry } from '@/components/prep/simulation';
import { type Block, Towers3D, WEALTH_COLOR, type WealthColor } from '@/components/prep/towers-3d';
import { cn } from '@/lib/shadcn/utils';
import type {
  Asset,
  CashFlow,
  Liability,
  Pension,
  PrepState,
  Settings,
  Succession,
  WealthSection,
} from '@/lib/types';
import {
  computeTotals,
  countryName,
  formatCompact,
  formatDate,
  formatMoney,
  formatNumber,
  humanize,
  isHouseBank,
  toBase,
} from '@/lib/wealth';

type View = 'visual' | 'table';

/** What every row and block needs to light up together. */
interface Highlight {
  changed: Set<string>;
  focus: Set<string>;
  hoverId: string | null;
  onHover: (id: string | null) => void;
  /** Remounting a changed row restarts its highlight animation. */
  rowKey: (id: string) => string;
}

function highlightClass(id: string, { changed, focus, hoverId }: Highlight) {
  return cn(
    'transition-colors',
    hoverId === id && 'bg-muted/60',
    changed.has(id) && 'row-flash',
    focus.has(id) && 'row-focus'
  );
}

function Swatch({ color, className }: { color: WealthColor; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('size-2 shrink-0 rounded-[2px]', className)}
      style={{ background: WEALTH_COLOR[color] }}
    />
  );
}

/** The visual view remembers itself per section, so the banker's choice survives a reload. */
function useStoredView(key: string): [View, (view: View) => void] {
  const [view, setView] = useState<View>('visual');
  useEffect(() => {
    if (window.localStorage.getItem(key) === 'table') setView('table');
  }, [key]);
  return [
    view,
    (next) => {
      setView(next);
      window.localStorage.setItem(key, next);
    },
  ];
}

// --- table view ---------------------------------------------------------------

interface RowProps {
  id: string;
  title: string;
  details: (string | null)[];
  amount: number | null;
  currency: string | null;
  color?: WealthColor;
  settings: Settings;
  highlight: Highlight;
}

/** One line of a T-account: what it is on the left, how much on the right. */
function Row({ id, title, details, amount, currency, color, settings, highlight }: RowProps) {
  const base = toBase(amount, currency, settings);
  const foreign = currency !== null && currency !== settings.baseCurrency;
  return (
    <li
      data-item-id={id}
      onPointerEnter={() => highlight.onHover(id)}
      onPointerLeave={() => highlight.onHover(null)}
      className={cn(
        'flex items-baseline justify-between gap-4 px-4 py-2',
        highlightClass(id, highlight)
      )}
    >
      <div className="flex min-w-0 items-baseline gap-2.5">
        {color && <Swatch color={color} className="translate-y-[-1px]" />}
        <div className="min-w-0">
          <div className="truncate text-sm">{title}</div>
          <div className="text-muted-foreground truncate text-xs">
            {details.filter(Boolean).join(' · ') || '—'}
          </div>
        </div>
      </div>
      <div className="shrink-0 text-right">
        {amount === null ? (
          <div className="text-warning text-sm">Value unknown</div>
        ) : (
          <div className="text-sm tabular-nums">{formatMoney(amount, currency)}</div>
        )}
        {foreign && base !== null && (
          <div className="text-muted-foreground text-xs tabular-nums">
            {formatMoney(base, settings.baseCurrency)}
          </div>
        )}
      </div>
    </li>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-muted-foreground bg-muted/40 px-4 py-1.5 text-xs font-medium">
        {title}
      </div>
      <ul className="divide-y">{children}</ul>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <li className="text-muted-foreground px-4 py-2 text-sm">{children}</li>;
}

interface SideProps {
  title: string;
  total: number;
  currency: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

/** One side of a T-account. */
function Side({ title, total, currency, children, footer }: SideProps) {
  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex items-baseline justify-between gap-4 border-b-2 border-current px-4 py-2">
        <h3 className="text-sm font-semibold tracking-wide uppercase">{title}</h3>
        <span className="text-sm font-semibold tabular-nums">
          {currency} <AnimatedNumber value={total} format={formatNumber} />
        </span>
      </div>
      <div className="flex-1">{children}</div>
      {footer}
    </div>
  );
}

// --- visual view --------------------------------------------------------------

interface ListItem {
  id: string;
  color: WealthColor;
  label: string;
  /** In base currency; null when the value is not known. */
  value: number | null;
  /** The item triggers a tax in the simulation on screen. */
  taxed?: boolean;
}

interface ListGroup {
  title: string;
  items: ListItem[];
}

/** The items of one tower, beside it: nothing the table shows is hidden in the visual view. */
function ItemList({ groups, highlight }: { groups: ListGroup[]; highlight: Highlight }) {
  const shown = groups.filter((group) => group.items.length > 0);
  if (shown.length === 0) {
    return <p className="text-muted-foreground text-sm">None recorded</p>;
  }
  return (
    <div className="min-w-0 space-y-3">
      {shown.map((group) => (
        <div key={group.title}>
          <div className="text-muted-foreground mb-0.5 px-2 text-xs">{group.title}</div>
          <ul>
            {group.items.map((item) => (
              <li
                key={highlight.rowKey(item.id)}
                data-item-id={item.id}
                onPointerEnter={() => highlight.onHover(item.id)}
                onPointerLeave={() => highlight.onHover(null)}
                className={cn(
                  'flex items-baseline gap-2 rounded-md px-2 py-1 text-sm',
                  highlightClass(item.id, highlight)
                )}
              >
                <Swatch color={item.color} className="translate-y-[-1px]" />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.value === null ? (
                  <span className="text-warning shrink-0 text-xs">unknown</span>
                ) : (
                  <span className="shrink-0 tabular-nums">
                    {item.taxed && (
                      <span className="text-danger mr-1.5 text-[11px] font-medium">taxed</span>
                    )}
                    {formatCompact(item.value)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

// --- section ------------------------------------------------------------------

interface Figure {
  label: string;
  value: number;
}

interface SectionProps {
  title: string;
  currency: string;
  headline: Figure;
  figures: Figure[];
  view: View;
  onView: (view: View) => void;
  /** Items whose details are not complete; shown on the Table tab, where the details are. */
  incomplete: number;
  /** Reduced to its title and headline: the review is on another part of the screen. */
  folded?: boolean;
  onUnfold?: () => void;
  children: React.ReactNode;
}

/** A card with its headline figures and the Visual | Table switch. */
function Section({
  title,
  currency,
  headline,
  figures,
  view,
  onView,
  incomplete,
  folded,
  onUnfold,
  children,
}: SectionProps) {
  if (folded) {
    return (
      <section className="bg-card overflow-hidden rounded-lg border">
        <button
          type="button"
          onClick={onUnfold}
          className="hover:bg-muted/50 flex w-full cursor-pointer items-baseline justify-between gap-4 px-5 py-2.5 text-left"
        >
          <span className="text-muted-foreground text-xs font-medium">{title}</span>
          <span className="text-sm tabular-nums">
            <span className="text-muted-foreground text-xs">{headline.label} </span>
            {currency} {formatNumber(headline.value)}
            <span className="text-muted-foreground ml-3 text-xs">Show</span>
          </span>
        </button>
      </section>
    );
  }
  return (
    <section className="bg-card overflow-hidden rounded-lg border">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b px-5 py-3">
        <div className="flex flex-wrap items-end gap-x-8 gap-y-2">
          <div>
            <h2 className="text-muted-foreground text-xs font-medium">{title}</h2>
            <div className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">
              <span className="text-muted-foreground mr-1.5 text-sm font-normal">{currency}</span>
              <AnimatedNumber value={headline.value} format={formatNumber} />
            </div>
            <div className="text-muted-foreground text-xs">{headline.label}</div>
          </div>
          {figures.map((figure) => (
            <div key={figure.label}>
              <div className="text-base font-medium tabular-nums">
                <AnimatedNumber value={figure.value} format={formatCompact} />
              </div>
              <div className="text-muted-foreground text-xs">{figure.label}</div>
            </div>
          ))}
        </div>

        <div role="tablist" aria-label={`${title} view`} className="bg-muted flex rounded-lg p-0.5">
          {(['visual', 'table'] as const).map((id) => (
            <button
              key={id}
              role="tab"
              type="button"
              aria-selected={view === id}
              onClick={() => onView(id)}
              className={cn(
                'flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1 text-sm transition-colors',
                view === id
                  ? 'bg-background font-medium shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {id === 'visual' ? 'Visual' : 'Table'}
              {id === 'table' && incomplete > 0 && (
                <span className="bg-warning/15 text-warning rounded-full px-1.5 text-xs font-medium">
                  {incomplete} incomplete
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
      {children}
    </section>
  );
}

// --- the view -----------------------------------------------------------------

interface WealthViewProps {
  state: PrepState;
  settings: Settings;
  changed: Set<string>;
  /** Items Warren is talking about right now. */
  focus: Set<string>;
  /** The item under the pointer anywhere on screen: a block, a row, or a meeting point about it. */
  hoverId: string | null;
  onHover: (id: string | null) => void;
  /** The death-of-the-client simulation, when it is the picture on screen. */
  simulation: Succession | null;
  /** In a guided review: the section the current step is about. The others fold. */
  focusSection?: WealthSection | null;
}

export function WealthView({
  state,
  settings,
  changed,
  focus,
  hoverId,
  onHover: setHoverId,
  simulation,
  focusSection = null,
}: WealthViewProps) {
  // Sections the banker opened by hand while the review is elsewhere; forgotten at the next step.
  const [opened, setOpened] = useState<Set<WealthSection>>(new Set());
  useEffect(() => setOpened(new Set()), [focusSection]);
  const isFolded = (section: WealthSection) =>
    focusSection !== null && focusSection !== section && !opened.has(section);
  const unfold = (section: WealthSection) => () => setOpened((prev) => new Set(prev).add(section));
  const [balanceView, setBalanceView] = useStoredView('warren.view.balance');
  const [flowView, setFlowView] = useStoredView('warren.view.cashflow');

  const totals = computeTotals(state, settings);
  const currency = settings.baseCurrency;
  const highlight: Highlight = {
    changed,
    focus,
    hoverId,
    onHover: setHoverId,
    rowKey: (id) => (changed.has(id) ? `${id}-${state.rev}` : id),
  };
  const base = (item: { amount: number | null; currency: string | null }) =>
    toBase(item.amount, item.currency, settings);
  const label = (item: { label: string | null; type: string }) => item.label ?? humanize(item.type);

  // An item is incomplete when a value is missing or the agent has an open question about it.
  const questioned = new Set(
    state.meetingPoints
      .filter((p) => p.status === 'open' && p.kind === 'missing' && p.relatedItemId)
      .map((p) => p.relatedItemId)
  );
  const incomplete = (items: { id: string; amount: number | null; currency: string | null }[]) =>
    items.filter((i) => i.amount === null || !i.currency || questioned.has(i.id)).length;
  // A cash flow also needs to say how often it happens, and when if it happens once.
  const undated = state.cashFlows.filter(
    (f) =>
      f.amount !== null &&
      f.currency &&
      !questioned.has(f.id) &&
      (f.frequency === null || (f.frequency === 'one_off' && !f.date))
  ).length;

  /** The blocks of a tower: the items that have a value. */
  const blocks = (items: ListItem[]): Block[] =>
    items.flatMap((i) => (i.value && i.value > 0 ? [{ ...i, value: i.value }] : []));

  // --- the simulation: where the estate goes instead of how it is financed ---
  const taxedAssets = new Set(simulation?.taxes.flatMap((t) => t.assetIds) ?? []);
  const taxItems: ListItem[] = simulation
    ? taxesByCountry(simulation).map(({ country, total }) => ({
        id: `tax-${country}`,
        color: 'tax',
        label: `Tax · ${countryName(country)}`,
        value: total,
      }))
    : [];
  const heirsItem: ListItem = {
    id: 'net-worth',
    color: 'heirs',
    label: 'Net to the heirs',
    value: simulation?.netToHeirs ?? 0,
  };

  // --- balance sheet ---
  const bankable = state.assets.filter((a) => a.bankable !== false);
  const atBank = bankable.filter((a) => isHouseBank(a.bank, settings));
  const elsewhere = bankable.filter((a) => !isHouseBank(a.bank, settings));
  const nonBankable = state.assets.filter((a) => a.bankable === false);
  const assetItems = (assets: Asset[], color: WealthColor): ListItem[] =>
    assets.map((a) => ({
      id: a.id,
      color,
      label: label(a),
      value: base(a),
      taxed: taxedAssets.has(a.id),
    }));

  const assetGroups: ListGroup[] = [
    { title: `At ${settings.houseBank}`, items: assetItems(atBank, 'bank') },
    { title: 'At other banks', items: assetItems(elsewhere, 'other') },
    { title: 'Non-bankable', items: assetItems(nonBankable, 'illiquid') },
  ];
  const debtItems: ListItem[] = state.liabilities.map((l) => ({
    id: l.id,
    color: 'debt',
    label: label(l),
    value: base(l),
  }));
  const netWorthItem: ListItem = {
    id: 'net-worth',
    color: 'net',
    label: 'Net worth',
    value: totals.netWorth,
  };

  // --- income and expenses ---
  const flows = (direction: 'income' | 'expense', oneOff: boolean) =>
    state.cashFlows.filter(
      (f) => f.direction === direction && (f.frequency === 'one_off') === oneOff
    );
  const flowItems = (direction: 'income' | 'expense'): ListItem[] =>
    flows(direction, false).map((f) => ({
      id: f.id,
      color: direction,
      label: label(f),
      value: base(f),
    }));
  const incomeItems = flowItems('income');
  const expenseItems = flowItems('expense');
  const oneOffs = state.cashFlows.filter((f) => f.frequency === 'one_off');
  const surplus = totals.recurringIncome - totals.recurringExpenses;
  // The two towers are made equal: what is left over sits on the expenses, what is missing on
  // the income, as the part of spending that capital has to fund.
  const surplusItem: ListItem = {
    id: 'surplus',
    color: 'surplus',
    label: 'Surplus',
    value: surplus,
  };
  const shortfallItem: ListItem = {
    id: 'shortfall',
    color: 'shortfall',
    label: 'Funded from capital',
    value: -surplus,
  };

  const assetRow = (a: Asset, color: WealthColor) => (
    <Row
      key={highlight.rowKey(a.id)}
      id={a.id}
      color={color}
      title={label(a)}
      details={[
        a.label ? humanize(a.type) : null,
        a.bankable === false ? null : (a.bank ?? 'Bank unknown'),
        a.country ?? 'Country unknown',
      ]}
      amount={a.amount}
      currency={a.currency}
      settings={settings}
      highlight={highlight}
    />
  );
  const liabilityRow = (l: Liability) => (
    <Row
      key={highlight.rowKey(l.id)}
      id={l.id}
      color="debt"
      title={label(l)}
      details={[
        l.label ? humanize(l.type) : null,
        l.bank ?? 'Lender unknown',
        l.country ?? 'Country unknown',
      ]}
      amount={l.amount}
      currency={l.currency}
      settings={settings}
      highlight={highlight}
    />
  );
  const flowRow = (f: CashFlow) => (
    <Row
      key={highlight.rowKey(f.id)}
      id={f.id}
      color={f.frequency === 'one_off' ? undefined : f.direction}
      title={label(f)}
      details={[
        f.label ? humanize(f.type) : null,
        f.frequency === 'one_off' ? (f.date ? formatDate(f.date) : 'Date unknown') : null,
        f.frequency === null ? 'Frequency unknown' : null,
      ]}
      amount={f.amount}
      currency={f.currency}
      settings={settings}
      highlight={highlight}
    />
  );
  const pensionRow = (p: Pension) => (
    <Row
      key={highlight.rowKey(p.id)}
      id={p.id}
      title={p.provider ?? humanize(p.type)}
      details={[humanize(p.type), p.country]}
      amount={p.amount}
      currency={p.currency}
      settings={settings}
      highlight={highlight}
    />
  );
  const flowSide = (direction: 'income' | 'expense') => {
    const recurring = flows(direction, false);
    const oneOff = flows(direction, true);
    return (
      <>
        <Group title="Recurring, per year">
          {recurring.length ? recurring.map(flowRow) : <Empty>None recorded</Empty>}
        </Group>
        {oneOff.length > 0 && <Group title="One-off">{oneOff.map(flowRow)}</Group>}
      </>
    );
  };

  const visualGrid =
    'grid grid-cols-1 items-center gap-x-4 gap-y-6 px-4 py-4 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]';

  return (
    <div className="space-y-5">
      <Section
        title="Balance sheet"
        folded={isFolded('balance')}
        onUnfold={unfold('balance')}
        currency={currency}
        headline={
          simulation
            ? { label: 'Would reach the heirs', value: simulation.netToHeirs }
            : { label: 'Net worth', value: totals.netWorth }
        }
        figures={
          simulation
            ? [
                { label: 'Net worth today', value: totals.netWorth },
                { label: 'Cost of inaction, up to', value: simulation.costHigh },
              ]
            : [
                { label: 'Assets', value: totals.assets },
                { label: 'Liabilities', value: totals.liabilities },
              ]
        }
        view={balanceView}
        onView={setBalanceView}
        incomplete={incomplete([...state.assets, ...state.liabilities])}
      >
        {balanceView === 'visual' ? (
          <div className={visualGrid}>
            <ItemList groups={assetGroups} highlight={highlight} />
            <Towers3D
              left={{ title: 'Assets', blocks: blocks(assetGroups.flatMap((g) => g.items)) }}
              right={
                simulation
                  ? {
                      title: 'Where it goes',
                      blocks: blocks([...debtItems, heirsItem, ...taxItems]),
                    }
                  : { title: 'Financed by', blocks: blocks([...debtItems, netWorthItem]) }
              }
              currency={currency}
              description={`Balance sheet: assets ${currency} ${formatNumber(totals.assets)}, liabilities ${currency} ${formatNumber(totals.liabilities)}, net worth ${currency} ${formatNumber(totals.netWorth)}.`}
              changed={changed}
              focus={focus}
              hoverId={hoverId}
              onHover={setHoverId}
            />
            <ItemList
              groups={
                simulation
                  ? [
                      { title: 'Taxes on death, up to', items: taxItems },
                      { title: 'Heirs', items: [heirsItem] },
                      { title: 'Liabilities repaid', items: debtItems },
                    ]
                  : [
                      { title: 'Liabilities', items: debtItems },
                      { title: 'Equity', items: [netWorthItem] },
                    ]
              }
              highlight={highlight}
            />
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 md:divide-x">
            <Side title="Assets" total={totals.assets} currency={currency}>
              <Group title={`Bankable · at ${settings.houseBank}`}>
                {atBank.length ? (
                  atBank.map((a) => assetRow(a, 'bank'))
                ) : (
                  <Empty>None recorded</Empty>
                )}
              </Group>
              <Group title="Bankable · other banks">
                {elsewhere.length ? (
                  elsewhere.map((a) => assetRow(a, 'other'))
                ) : (
                  <Empty>None recorded</Empty>
                )}
              </Group>
              <Group title="Non-bankable">
                {nonBankable.length ? (
                  nonBankable.map((a) => assetRow(a, 'illiquid'))
                ) : (
                  <Empty>None recorded</Empty>
                )}
              </Group>
            </Side>
            <Side
              title="Liabilities"
              total={totals.liabilities}
              currency={currency}
              footer={
                <div
                  onPointerEnter={() => setHoverId('net-worth')}
                  onPointerLeave={() => setHoverId(null)}
                  className="flex items-baseline justify-between gap-4 border-t-2 border-current px-4 py-2"
                >
                  <span className="flex items-baseline gap-2.5 text-sm font-semibold tracking-wide uppercase">
                    <Swatch color="net" className="translate-y-[-1px]" />
                    Net worth
                  </span>
                  <span className="text-sm font-semibold tabular-nums">
                    {currency} <AnimatedNumber value={totals.netWorth} format={formatNumber} />
                  </span>
                </div>
              }
            >
              <ul className="divide-y">
                {state.liabilities.length ? (
                  state.liabilities.map(liabilityRow)
                ) : (
                  <Empty>None recorded</Empty>
                )}
              </ul>
            </Side>
          </div>
        )}
        {simulation && (
          <CostOfInaction
            state={state}
            succession={simulation}
            settings={settings}
            hoverId={hoverId}
            onHover={setHoverId}
          />
        )}
      </Section>

      <Section
        title="Income and expenses, per year"
        folded={isFolded('cashflow')}
        onUnfold={unfold('cashflow')}
        currency={currency}
        headline={{
          label: surplus < 0 ? 'Shortfall, funded from capital' : 'Surplus',
          value: Math.abs(surplus),
        }}
        figures={[
          { label: 'Income', value: totals.recurringIncome },
          { label: 'Expenses', value: totals.recurringExpenses },
        ]}
        view={flowView}
        onView={setFlowView}
        incomplete={incomplete(state.cashFlows) + undated}
      >
        {flowView === 'visual' ? (
          <>
            {incomeItems.length + expenseItems.length === 0 ? (
              <p className="text-muted-foreground px-5 py-6 text-sm">
                No recurring income or expenses recorded yet.
              </p>
            ) : (
              <div className={visualGrid}>
                <ItemList
                  groups={[
                    { title: 'Income', items: incomeItems },
                    { title: 'Gap', items: surplus < 0 ? [shortfallItem] : [] },
                  ]}
                  highlight={highlight}
                />
                <Towers3D
                  left={{
                    title: 'Income',
                    blocks: blocks(surplus < 0 ? [...incomeItems, shortfallItem] : incomeItems),
                  }}
                  right={{
                    title: surplus > 0 ? 'Spent and saved' : 'Expenses',
                    blocks: blocks(surplus > 0 ? [...expenseItems, surplusItem] : expenseItems),
                  }}
                  currency={currency}
                  description={`Recurring income ${currency} ${formatNumber(totals.recurringIncome)} a year, recurring expenses ${currency} ${formatNumber(totals.recurringExpenses)}.`}
                  changed={changed}
                  focus={focus}
                  hoverId={hoverId}
                  onHover={setHoverId}
                />
                <ItemList
                  groups={[
                    { title: 'Expenses', items: expenseItems },
                    { title: 'Left over', items: surplus > 0 ? [surplusItem] : [] },
                  ]}
                  highlight={highlight}
                />
              </div>
            )}
            {oneOffs.length > 0 && (
              <div className="border-t">
                <div className="text-muted-foreground bg-muted/40 px-4 py-1.5 text-xs font-medium">
                  One-off, not in the picture above
                </div>
                <ul className="grid grid-cols-1 md:grid-cols-2 md:[&>li:nth-child(odd)]:border-r">
                  {oneOffs.map((f) => (
                    <Row
                      key={highlight.rowKey(f.id)}
                      id={f.id}
                      title={label(f)}
                      details={[
                        f.direction === 'income' ? 'Income' : 'Expense',
                        f.date ? formatDate(f.date) : 'Date unknown',
                      ]}
                      amount={f.amount}
                      currency={f.currency}
                      settings={settings}
                      highlight={highlight}
                    />
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 md:divide-x">
            <Side title="Income" total={totals.recurringIncome} currency={currency}>
              {flowSide('income')}
            </Side>
            <Side title="Expenses" total={totals.recurringExpenses} currency={currency}>
              {flowSide('expense')}
            </Side>
          </div>
        )}
      </Section>

      <section className="bg-card overflow-hidden rounded-lg border border-dashed">
        <div className="flex items-baseline justify-between gap-4 border-b px-4 py-2">
          <h2 className="text-muted-foreground text-xs font-medium">
            Off balance sheet · Pension plans
          </h2>
          <span className="text-muted-foreground text-xs tabular-nums">
            {currency} <AnimatedNumber value={totals.pensions} format={formatNumber} />
          </span>
        </div>
        {isFolded('pensions') ? (
          <button
            type="button"
            onClick={unfold('pensions')}
            className="text-muted-foreground hover:bg-muted/50 w-full cursor-pointer px-4 py-2 text-left text-xs"
          >
            {state.pensions.length} recorded · Show
          </button>
        ) : (
          <ul className="grid grid-cols-1 md:grid-cols-2 md:[&>li:nth-child(odd)]:border-r">
            {state.pensions.length ? state.pensions.map(pensionRow) : <Empty>None recorded</Empty>}
          </ul>
        )}
      </section>
    </div>
  );
}
