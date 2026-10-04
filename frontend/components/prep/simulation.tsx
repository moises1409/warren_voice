import { cn } from '@/lib/shadcn/utils';
import type { PrepState, Settings, Succession, SuccessionTax } from '@/lib/types';
import { countryName, formatNumber, humanize } from '@/lib/wealth';

/** Taxes of the simulation added up per rule: one line per thing to discuss. */
export function taxesByRule(succession: Succession): (SuccessionTax & { total: number })[] {
  const byRule = new Map<string, SuccessionTax & { total: number }>();
  for (const tax of succession.taxes) {
    const entry = byRule.get(tax.ruleId) ?? { ...tax, total: 0 };
    entry.total += tax.high;
    byRule.set(tax.ruleId, entry);
  }
  return [...byRule.values()].sort((a, b) => b.total - a.total);
}

/** Taxes added up per country: one block of the tower each. */
export function taxesByCountry(succession: Succession): { country: string; total: number }[] {
  const byCountry = new Map<string, number>();
  for (const tax of succession.taxes) {
    byCountry.set(tax.country, (byCountry.get(tax.country) ?? 0) + tax.high);
  }
  return [...byCountry].map(([country, total]) => ({ country, total }));
}

/** What the figures rest on. Shown with every simulation: they are estimates, not advice. */
export function SimulationNote({
  succession,
  className,
}: {
  succession: Succession;
  className?: string;
}) {
  return (
    <div className={cn('text-muted-foreground text-xs leading-relaxed', className)}>
      <p>
        <span className="text-foreground font-medium">Indicative estimate, not tax advice.</span>{' '}
        {succession.illustrative
          ? `Computed with illustrative rules (${succession.rulesVersion}) that have not been validated by the bank's tax experts.`
          : `Computed with the bank's rules, version ${succession.rulesVersion}.`}
      </p>
      <details className="mt-1.5">
        <summary className="cursor-pointer select-none">
          Assumptions
          {succession.missingInputs.length > 0 && ` · ${succession.missingInputs.length} not known`}
        </summary>
        <ul className="mt-1.5 list-disc space-y-0.5 pl-4">
          {succession.assumptions.map((assumption) => (
            <li key={assumption}>{assumption}</li>
          ))}
          {succession.missingInputs.map((input) => (
            <li key={input} className="text-warning">
              Not known: {input}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

interface CostOfInactionProps {
  state: PrepState;
  succession: Succession;
  settings: Settings;
  hoverId?: string | null;
  onHover?: (id: string | null) => void;
}

/** The taxes the client's death would trigger, one line per rule, with the expert to involve. */
export function CostOfInaction({
  state,
  succession,
  settings,
  hoverId,
  onHover,
}: CostOfInactionProps) {
  const currency = settings.baseCurrency;
  const rows = taxesByRule(succession);
  const assetNames = new Map(state.assets.map((a) => [a.id, a.label ?? humanize(a.type)]));
  const memberNames = new Map(state.family.members.map((m) => [m.id, m.name ?? 'Heir']));

  return (
    <div className="border-t">
      <div className="text-muted-foreground bg-muted/40 flex items-baseline justify-between gap-4 px-4 py-1.5 text-xs font-medium">
        <span>Cost of inaction · taxes on the client&apos;s death</span>
        <span className="tabular-nums">
          up to {currency} {formatNumber(succession.costHigh)}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="text-muted-foreground px-4 py-3 text-sm">
          The rules find no tax on death for the recorded assets and heirs.
        </p>
      ) : (
        <ul className="divide-y">
          {rows.map((tax) => {
            // What the line is about: the assets for a tax on assets, the heir otherwise.
            const target = tax.assetIds[0] ?? tax.heirId;
            const what =
              tax.layer === 'situs'
                ? tax.assetIds.map((id) => assetNames.get(id) ?? id).join(', ')
                : (memberNames.get(tax.heirId ?? '') ?? 'Heir');
            return (
              <li
                key={tax.ruleId}
                onPointerEnter={() => onHover?.(target ?? null)}
                onPointerLeave={() => onHover?.(null)}
                className={cn(
                  'grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 px-4 py-2 transition-colors',
                  target && hoverId === target && 'bg-muted/60'
                )}
              >
                <div className="min-w-0">
                  <div className="text-sm">{tax.topic}</div>
                  <div className="text-muted-foreground truncate text-xs">
                    {what} · {countryName(tax.country)} · involve{' '}
                    {succession.experts[tax.expert] ?? tax.expert}
                  </div>
                  <div className="text-muted-foreground mt-0.5 text-[11px] italic">
                    {tax.source}
                  </div>
                </div>
                <div className="text-right text-sm tabular-nums">
                  <span className="text-muted-foreground text-xs">up to </span>
                  {currency} {formatNumber(tax.total)}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-t px-4 py-2 text-sm">
        <span>
          <span className="text-muted-foreground">Liquid assets to pay it: </span>
          <span className="tabular-nums">
            {currency} {formatNumber(succession.liquidAssets)}
          </span>
        </span>
        {succession.liquidityGap > 0 ? (
          <span className="text-danger">
            Short by {currency} {formatNumber(succession.liquidityGap)}: the heirs might have to
            sell or borrow
          </span>
        ) : (
          <span className="text-muted-foreground">Covered by liquid assets</span>
        )}
      </div>
      <SimulationNote succession={succession} className="border-t px-4 py-3" />
    </div>
  );
}
