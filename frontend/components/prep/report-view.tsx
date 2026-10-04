'use client';

import { useState } from 'react';
import { motion } from 'motion/react';
import {
  CheckCircleIcon,
  CheckIcon,
  CircleNotchIcon,
  CopyIcon,
  PrinterIcon,
  UsersThreeIcon,
} from '@phosphor-icons/react';
import { AnimatedNumber } from '@/components/prep/animated-number';
import { Badge } from '@/components/prep/badge';
import { KIND, SECTIONS } from '@/components/prep/meeting-points';
import { CostOfInaction } from '@/components/prep/simulation';
import { type Block, Towers3D } from '@/components/prep/towers-3d';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/shadcn/utils';
import type { PrepState, Report, Settings, Slice } from '@/lib/types';
import {
  ageOn,
  computeTotals,
  countryName,
  formatDate,
  formatNumber,
  humanize,
} from '@/lib/wealth';

const NO_IDS = new Set<string>();

/** Cards arrive one after the other, so the report is seen being put together. */
function rise(index: number) {
  return {
    initial: { opacity: 0, y: 14 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.4, delay: Math.min(index * 0.07, 0.8) },
  };
}

function Kpi({
  label,
  value,
  currency,
  tone,
}: {
  label: string;
  value: number;
  currency: string;
  tone?: 'danger';
}) {
  return (
    <div>
      <div className="text-muted-foreground text-xs">{label}</div>
      <div
        className={cn(
          'mt-0.5 text-xl font-semibold tracking-tight tabular-nums',
          tone === 'danger' && value > 0 && 'text-danger'
        )}
      >
        <span className="text-muted-foreground mr-1 text-xs font-normal">{currency}</span>
        <AnimatedNumber value={value} from={0} format={formatNumber} />
      </div>
    </div>
  );
}

/** What the report is made of, ticked off as each part is really there. */
function BuildSteps({ report }: { report: Report }) {
  const ready = report.status === 'ready';
  const steps = [
    { label: 'Figures', done: true },
    { label: 'Experts to invite', done: true },
    { label: 'Summary', done: ready, active: !ready },
    { label: 'Conversation openers', done: ready, active: !ready && report.summary.length > 0 },
  ];
  return (
    <ol className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm">
      {steps.map((step) => (
        <li
          key={step.label}
          className={cn(
            'flex items-center gap-1.5 transition-colors',
            step.done ? 'text-foreground' : 'text-muted-foreground'
          )}
        >
          {step.done ? (
            <CheckCircleIcon weight="fill" className="text-success size-4" />
          ) : step.active ? (
            <CircleNotchIcon className="text-primary size-4 animate-spin" />
          ) : (
            <span className="border-muted-foreground/40 size-3.5 rounded-full border" />
          )}
          {step.label}
        </li>
      ))}
    </ol>
  );
}

function Breakdown({
  title,
  slices,
  label,
}: {
  title: string;
  slices: Slice[];
  label: (key: string) => string;
}) {
  return (
    <div className="px-4 py-3">
      <h3 className="text-muted-foreground mb-2 text-xs font-medium">{title}</h3>
      <ul className="space-y-1.5">
        {slices.slice(0, 5).map((slice, index) => (
          <li key={slice.key} className="text-sm">
            <div className="flex justify-between gap-3">
              <span className="truncate">{label(slice.key)}</span>
              <span className="tabular-nums">{Math.round(slice.share * 100)}%</span>
            </div>
            <div className="bg-muted mt-0.5 h-1 overflow-hidden rounded-full">
              <motion.div
                className="bg-primary h-1 rounded-full"
                initial={{ width: 0 }}
                animate={{ width: `${Math.max(slice.share * 100, 1)}%` }}
                transition={{ duration: 0.7, delay: 0.15 + index * 0.06, ease: 'easeOut' }}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function asText(state: PrepState, report: Report, settings: Settings): string {
  const lines = [`Meeting preparation: ${state.client.name}`, '', report.summary, ''];
  for (const { id, label } of SECTIONS) {
    const points = report.points.filter((p) => p.section === id);
    if (points.length === 0) continue;
    lines.push(label.toUpperCase());
    for (const point of points) lines.push(`- ${point.topic}: ${point.opener}`);
    lines.push('');
  }
  if (report.experts?.length) {
    lines.push('EXPERTS TO INVITE');
    for (const expert of report.experts) {
      const amount =
        expert.amount > 0
          ? ` (up to ${settings.baseCurrency} ${formatNumber(expert.amount)} at stake)`
          : '';
      lines.push(`- ${expert.label}${amount}`);
    }
  }
  return lines.join('\n').trim();
}

interface ReportViewProps {
  state: PrepState;
  settings: Settings;
}

export function ReportView({ state, settings }: ReportViewProps) {
  const [copied, setCopied] = useState(false);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const { report, client, succession } = state;
  const currency = settings.baseCurrency;

  if (!report) {
    return (
      <div className="bg-card text-muted-foreground rounded-lg border p-6 text-sm">
        The report is put together when the review with Warren reaches this stage. Ask Warren for
        the report, or select this step during the conversation.
      </div>
    );
  }

  const totals = computeTotals(state, settings);
  const byId = new Map(state.meetingPoints.map((p) => [p.id, p]));
  const generating = report.status === 'generating';
  const cost = succession?.costHigh ?? 0;

  // The balance sheet in two towers, as on the wealth stage, one block per kind of asset.
  const block = (id: string, color: Block['color'], label: string, value: number): Block[] =>
    value > 0 ? [{ id, color, label, value }] : [];
  const assets = [
    ...block('bank', 'bank', `At ${settings.houseBank}`, totals.aumBank),
    ...block('other', 'other', 'At other banks', totals.bankable - totals.aumBank),
    ...block('illiquid', 'illiquid', 'Non-bankable', totals.nonBankable),
  ];
  const financed = [
    ...block('debt', 'debt', 'Liabilities', totals.liabilities),
    ...block('net', 'net', 'Net worth', totals.netWorth),
  ];

  const copy = async () => {
    await navigator.clipboard.writeText(asText(state, report, settings));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  let cardIndex = 0;

  return (
    <div className="space-y-5">
      {/* The meeting at a glance. */}
      <motion.section {...rise(0)} className="bg-card overflow-hidden rounded-lg border">
        <div className="grid grid-cols-1 gap-x-6 md:grid-cols-[minmax(0,1fr)_auto]">
          <div className="px-5 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                  Meeting preparation
                </div>
                <h2 className="mt-0.5 text-2xl font-semibold tracking-tight">{client.name}</h2>
                <p className="text-muted-foreground text-sm">
                  {ageOn(client.dateOfBirth)} · {client.domicile.city},{' '}
                  {countryName(client.domicile.country)} · {client.segment}
                  {report.generatedAt && ` · prepared ${formatDate(report.generatedAt)}`}
                </p>
              </div>
              <div className="no-print flex gap-1">
                <Button variant="ghost" size="xs" onClick={copy} disabled={generating}>
                  {copied ? <CheckIcon /> : <CopyIcon />}
                  {copied ? 'Copied' : 'Copy'}
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => window.print()}
                  disabled={generating}
                >
                  <PrinterIcon />
                  Print
                </Button>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
              <Kpi label="Net worth" value={totals.netWorth} currency={currency} />
              <Kpi label={`At ${settings.houseBank}`} value={totals.aumBank} currency={currency} />
              <Kpi label="At other banks" value={totals.aumExternal} currency={currency} />
              <Kpi label="Cost of inaction, up to" value={cost} currency={currency} tone="danger" />
            </div>

            {/* How much of the estate taxes on death would take. */}
            {succession && succession.estate > 0 && cost > 0 && (
              <div className="mt-4">
                <div className="bg-muted flex h-2 overflow-hidden rounded-full">
                  <motion.div
                    className="h-full"
                    style={{ background: 'var(--wealth-net)' }}
                    initial={{ width: '100%' }}
                    animate={{ width: `${(succession.netToHeirs / succession.estate) * 100}%` }}
                    transition={{ duration: 1.1, delay: 0.5, ease: 'easeInOut' }}
                  />
                  <div className="h-full flex-1" style={{ background: 'var(--wealth-tax)' }} />
                </div>
                <p className="text-muted-foreground mt-1 text-xs">
                  If the client died today, {currency} {formatNumber(succession.netToHeirs)} of the{' '}
                  {currency} {formatNumber(succession.estate)} estate would reach the heirs.
                </p>
              </div>
            )}
          </div>

          {/* Scaled down: the same towers as on the wealth stage. */}
          <div className="no-print hidden items-center justify-center pr-4 md:flex" aria-hidden>
            <div style={{ width: 236, height: 184 }}>
              <div style={{ transform: 'scale(0.56)', transformOrigin: 'top left' }}>
                <Towers3D
                  left={{ title: 'Assets', blocks: assets }}
                  right={{ title: 'Financed by', blocks: financed }}
                  currency={currency}
                  description="Balance sheet"
                  changed={NO_IDS}
                  focus={NO_IDS}
                  hoverId={hoverId}
                  onHover={setHoverId}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="bg-muted/40 no-print border-t px-5 py-2.5">
          <BuildSteps report={report} />
        </div>
      </motion.section>

      <motion.section {...rise(1)} className="bg-card rounded-lg border">
        <h2 className="text-muted-foreground border-b px-4 py-2 text-xs font-medium">
          Situation in brief
        </h2>
        <div className="px-4 py-3 text-sm leading-relaxed">
          {report.summary ? (
            <p className={cn(generating && 'writing')}>{report.summary}</p>
          ) : generating ? (
            <p className="text-muted-foreground writing">Warren is writing the summary</p>
          ) : (
            <p className="text-muted-foreground">
              The summary could not be written. The figures and the meeting points below are
              complete.
            </p>
          )}
        </div>
        <div className="grid grid-cols-1 divide-y border-t md:grid-cols-3 md:divide-x md:divide-y-0">
          <Breakdown title="Assets by type" slices={report.assetsByType} label={humanize} />
          <Breakdown title="By currency" slices={report.assetsByCurrency} label={(key) => key} />
          <Breakdown
            title="By country"
            slices={report.assetsByCountry}
            label={(key) => countryName(key) ?? key}
          />
        </div>
      </motion.section>

      {report.experts && report.experts.length > 0 && (
        <motion.section {...rise(2)} className="bg-card rounded-lg border">
          <h2 className="text-muted-foreground flex items-center gap-2 border-b px-4 py-2 text-xs font-medium">
            <UsersThreeIcon className="size-3.5" />
            Experts to invite to the meeting
          </h2>
          <ul className="grid grid-cols-1 gap-3 p-4 md:grid-cols-3">
            {report.experts.map((expert, index) => (
              <motion.li
                key={expert.id}
                {...rise(index + 3)}
                className="bg-primary/5 border-primary/30 rounded-lg border px-3 py-2.5"
              >
                <div className="text-sm font-semibold">{expert.label}</div>
                {expert.amount > 0 && (
                  <div className="text-danger mt-0.5 text-xs tabular-nums">
                    up to {currency} {formatNumber(expert.amount)} at stake
                  </div>
                )}
                <ul className="text-muted-foreground mt-1.5 list-disc space-y-1 pl-4 text-xs">
                  {expert.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </motion.li>
            ))}
          </ul>
        </motion.section>
      )}

      {succession && succession.taxes.length > 0 && (
        <motion.section {...rise(3)} className="bg-card overflow-hidden rounded-lg border">
          <h2 className="text-muted-foreground px-4 py-2 text-xs font-medium">
            If the client died today
          </h2>
          <CostOfInaction state={state} succession={succession} settings={settings} />
        </motion.section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold">Points to raise in the meeting</h2>
        {generating && (
          <p className="text-muted-foreground writing text-sm">
            Warren is preparing a way to open each point
          </p>
        )}
        {!generating && report.points.length === 0 && (
          <p className="text-muted-foreground text-sm">No open points.</p>
        )}
        <div className="space-y-5">
          {SECTIONS.map(({ id, label }) => {
            const points = report.points.filter((p) => p.section === id);
            if (points.length === 0) return null;
            return (
              <div key={id}>
                <h3 className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">
                  {label} · {points.length}
                </h3>
                <ol className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {points.map((point) => (
                    <motion.li
                      key={point.pointIds.join()}
                      {...rise(cardIndex++)}
                      className="bg-card flex flex-col rounded-lg border px-4 py-3"
                    >
                      <div className="text-sm font-semibold">{point.topic}</div>
                      <p className="border-primary mt-2 flex-1 border-l-2 pl-3 text-sm leading-relaxed">
                        “{point.opener}”
                      </p>
                      <ul className="mt-3 space-y-1">
                        {point.pointIds.map((pointId) => {
                          const source = byId.get(pointId);
                          if (!source) return null;
                          return (
                            <li
                              key={pointId}
                              className="text-muted-foreground flex items-baseline gap-2 text-xs"
                            >
                              <Badge tone={KIND[source.kind].tone}>{KIND[source.kind].label}</Badge>
                              <span>{source.text}</span>
                            </li>
                          );
                        })}
                      </ul>
                    </motion.li>
                  ))}
                </ol>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
