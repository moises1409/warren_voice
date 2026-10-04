'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  CircleIcon,
  MinusCircleIcon,
  NotePencilIcon,
} from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/shadcn/utils';
import type { PrepState, Step, StepGroup, StepOutcome } from '@/lib/types';
import { formatDate } from '@/lib/wealth';

const OUTCOME: Record<StepOutcome, string> = {
  answered: 'Done',
  for_meeting: 'For the meeting',
  dismissed: 'Dismissed',
  skipped: 'Skipped',
};

/** The groups of the review, in the order Warren takes them. */
const GROUPS: { id: StepGroup; label: string }[] = [
  { id: 'briefing', label: 'Start' },
  { id: 'wealth', label: 'Wealth' },
  { id: 'family', label: 'Family' },
  { id: 'general', label: 'General' },
  { id: 'simulation', label: 'If the client died today' },
  { id: 'report', label: 'Finish' },
];

/** Position of the current step, for "3 of 7"; the last step once the review is complete. */
export function progress(state: PrepState): { number: number; total: number } {
  const index = state.agenda.findIndex((s) => s.id === state.currentStepId);
  return { number: index < 0 ? state.agenda.length : index + 1, total: state.agenda.length };
}

interface NowCardProps {
  state: PrepState;
  onFinish: (outcome: StepOutcome) => void;
  onBack: () => void;
}

/**
 * The step the guided review is on. What Warren is talking about is what this card shows, and
 * each button does what the banker can also say.
 */
export function NowCard({ state, onFinish, onBack }: NowCardProps) {
  const step = state.agenda.find((s) => s.id === state.currentStepId);
  const { number, total } = progress(state);

  if (!step) {
    return (
      <div className="border-success/40 bg-success/5 mb-4 rounded-lg border-2 px-4 py-3">
        <div className="text-sm font-medium">Review complete</div>
        <p className="text-muted-foreground mt-0.5 text-sm">
          Everything has been gone through. The report lists what to raise in the meeting.
        </p>
      </div>
    );
  }

  const group = GROUPS.find((g) => g.id === step.group);
  const isCost = step.kind === 'point' && step.scenario !== null;
  // A step about an activity note shows the note itself: that is where the fact comes from.
  const note = (state.activityNotes ?? []).find((n) => n.id === step.itemId);

  return (
    <div className="border-primary bg-card sticky top-0 z-20 mb-4 rounded-lg border-2 px-4 py-3 shadow-md">
      <div className="flex items-center justify-between gap-4">
        <div className="text-muted-foreground text-xs font-medium">
          Now · {number} of {total}
          {group && step.kind === 'point' && ` · ${group.label}`}
        </div>
        <div className="bg-muted h-1 w-32 overflow-hidden rounded-full" aria-hidden>
          <div
            className="bg-primary h-full rounded-full transition-[width] duration-500"
            style={{ width: `${(number / total) * 100}%` }}
          />
        </div>
      </div>
      <div className="mt-1 text-base font-semibold tracking-tight">{step.title}</div>
      <p className="mt-0.5 text-sm leading-relaxed">{step.say}</p>
      {note && (
        <blockquote className="bg-background mt-2 flex gap-2 rounded-md border px-3 py-2 text-sm">
          <NotePencilIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
          <span>
            <span className="text-muted-foreground text-xs">
              CRM activity note · {formatDate(note.date)}
            </span>
            <span className="mt-0.5 block italic">“{note.text}”</span>
          </span>
        </blockquote>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {step.kind === 'point' ? (
          <>
            <Button size="sm" onClick={() => onFinish('for_meeting')}>
              {isCost ? 'Keep for the meeting' : 'Ask the client'}
              <ArrowRightIcon />
            </Button>
            <Button size="sm" variant="outline" onClick={() => onFinish('dismissed')}>
              Not relevant
            </Button>
            {!isCost && (
              <span className="text-muted-foreground text-xs">
                {note ? 'or tell Warren to record it' : 'or tell Warren the answer'}
              </span>
            )}
          </>
        ) : step.kind === 'offer' ? (
          <>
            <Button size="sm" onClick={() => onFinish('answered')}>
              Run the simulation
              <ArrowRightIcon />
            </Button>
            <Button size="sm" variant="outline" onClick={() => onFinish('dismissed')}>
              Skip to the report
            </Button>
          </>
        ) : step.kind === 'gate' ? (
          <>
            <Button size="sm" onClick={() => onFinish('answered')}>
              {step.group === 'report' ? 'Prepare the report' : 'Move on to the family'}
              <ArrowRightIcon />
            </Button>
            <span className="text-muted-foreground text-xs">
              or tell Warren — the screen changes once you agree
            </span>
          </>
        ) : step.kind === 'closing' ? null : (
          <Button size="sm" onClick={() => onFinish('answered')}>
            Continue
            <ArrowRightIcon />
          </Button>
        )}
        {number > 1 && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={onBack}>
            <ArrowLeftIcon />
            Back
          </Button>
        )}
      </div>
    </div>
  );
}

function StepIcon({ step, current }: { step: Step; current: boolean }) {
  if (current) return <ArrowRightIcon weight="bold" className="text-primary size-3.5" />;
  if (step.status === 'pending') return <CircleIcon className="text-muted-foreground size-3.5" />;
  if (step.outcome === 'dismissed' || step.outcome === 'skipped') {
    return <MinusCircleIcon className="text-muted-foreground size-3.5" />;
  }
  return <CheckIcon weight="bold" className="text-success size-3.5" />;
}

interface ReviewAgendaProps {
  state: PrepState;
  onSelect: (stepId: string) => void;
}

/** The steps of the review by group: where it is, what is done and how each step ended. */
export function ReviewAgenda({ state, onSelect }: ReviewAgendaProps) {
  const current = state.agenda.find((s) => s.id === state.currentStepId);

  return (
    <div className="space-y-3 p-3">
      {GROUPS.map(({ id, label }) => {
        const steps = state.agenda.filter((s) => s.group === id);
        if (steps.length === 0) return null;
        const done = steps.filter((s) => s.status === 'done').length;
        const active = current?.group === id;
        return (
          <section
            key={id}
            className={cn('rounded-lg border', active ? 'border-primary/50' : 'border-border')}
          >
            <div
              className={cn(
                'flex items-center justify-between gap-3 rounded-t-lg px-3 py-1.5',
                active ? 'bg-primary/10' : 'bg-muted/50'
              )}
            >
              <h3
                className={cn(
                  'text-xs font-semibold tracking-wide uppercase',
                  id === 'simulation' && 'text-danger'
                )}
              >
                {label}
              </h3>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-xs tabular-nums">
                  {done} of {steps.length}
                </span>
                <div className="bg-muted h-1 w-10 overflow-hidden rounded-full" aria-hidden>
                  <div
                    className={cn(
                      'h-full rounded-full transition-[width] duration-500',
                      done === steps.length ? 'bg-success' : 'bg-primary'
                    )}
                    style={{ width: `${(done / steps.length) * 100}%` }}
                  />
                </div>
              </div>
            </div>
            <ol className="p-1">
              {steps.map((step) => {
                const isCurrent = step.id === state.currentStepId;
                return (
                  <li key={step.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(step.id)}
                      aria-current={isCurrent ? 'step' : undefined}
                      className={cn(
                        'flex w-full cursor-pointer items-baseline gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                        isCurrent ? 'bg-primary/10 font-medium' : 'hover:bg-muted/60',
                        step.status === 'done' && !isCurrent && 'text-muted-foreground'
                      )}
                    >
                      <span className="translate-y-0.5">
                        <StepIcon step={step} current={isCurrent} />
                      </span>
                      <span className="min-w-0 flex-1 truncate">{step.title}</span>
                      {step.origin === 'banker' ? (
                        <span className="text-muted-foreground shrink-0 text-xs">Noted by you</span>
                      ) : (
                        step.status === 'done' &&
                        step.outcome &&
                        (step.kind === 'point' || step.outcome === 'skipped') && (
                          <span className="text-muted-foreground shrink-0 text-xs">
                            {OUTCOME[step.outcome]}
                          </span>
                        )
                      )}
                    </button>
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })}
    </div>
  );
}

/** How long the banner between two parts of the review stays up. */
const BANNER_MS = 2800;

/**
 * Marks the moment the review leaves one part and enters the next, so that the change of
 * subject, and of screen, is not missed. Shown only when the review moves forward.
 */
export function SectionBanner({ state }: { state: PrepState }) {
  const index = state.agenda.findIndex((s) => s.id === state.currentStepId);
  const group = index >= 0 ? state.agenda[index].group : null;
  const last = useRef<{ index: number; group: StepGroup | null }>({ index, group });
  const [shown, setShown] = useState<{ from: string; to: string } | null>(null);

  useEffect(() => {
    const before = last.current;
    last.current = { index, group };
    if (!group || !before.group || group === before.group || index <= before.index) return;
    if (before.group === 'briefing') return;
    const label = (id: StepGroup) => GROUPS.find((g) => g.id === id)?.label ?? id;
    setShown({ from: label(before.group), to: label(group) });
    const timer = setTimeout(() => setShown(null), BANNER_MS);
    return () => clearTimeout(timer);
  }, [index, group]);

  return (
    <AnimatePresence>
      {shown && (
        <motion.div
          role="status"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.35, ease: 'easeOut' }}
          className="bg-primary text-primary-foreground shrink-0 overflow-hidden"
        >
          <div className="flex items-center justify-center gap-3 px-5 py-2.5">
            <span className="flex items-center gap-1.5 text-sm opacity-80">
              <CheckIcon weight="bold" className="size-4" />
              {shown.from}
            </span>
            <ArrowRightIcon weight="bold" className="size-4" />
            <span className="text-base font-semibold">{shown.to}</span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
