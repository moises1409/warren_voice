'use client';

import { motion } from 'motion/react';
import { Badge } from '@/components/prep/badge';
import { SimulationNote } from '@/components/prep/simulation';
import { cn } from '@/lib/shadcn/utils';
import type { Client, FamilyMember, PrepState, Settings, Succession } from '@/lib/types';
import { ageOn, countryName, formatCompact, formatNumber, humanize } from '@/lib/wealth';

const PARTNER_RELATIONS = ['spouse', 'partner'];
const ADULT_AGE = 18;

// Cards slide to their new place when the tree is rearranged, and a new one grows in from
// the line it hangs on.
const SLIDE = { type: 'spring', stiffness: 420, damping: 38 } as const;
// Slow enough to be seen arriving, with a little overshoot.
const ENTER = {
  layout: SLIDE,
  opacity: { duration: 0.5 },
  scale: { type: 'spring', stiffness: 170, damping: 14 },
} as const;
const GROW_IN = { opacity: 0, scale: 0.6 };
const SETTLED = { opacity: 1, scale: 1 };

interface PersonProps {
  name: string;
  role: string;
  age: number | null;
  place: string | null;
  notes?: string | null;
  primary?: boolean;
  muted?: boolean;
  /** Facts worth noticing at a glance: lives abroad, is a minor, details missing. */
  marks?: React.ReactNode;
  /** What the person would receive in the simulation on screen. */
  inheritance?: React.ReactNode;
  /** The family member the card is for, so the review can scroll to it. */
  itemId?: string;
  flash?: boolean;
  focus?: boolean;
  lit?: boolean;
  onHover?: (over: boolean) => void;
}

function Person({
  name,
  role,
  age,
  place,
  notes,
  primary,
  muted,
  marks,
  inheritance,
  itemId,
  flash,
  focus,
  lit,
  onHover,
}: PersonProps) {
  return (
    <div
      data-item-id={itemId}
      onPointerEnter={() => onHover?.(true)}
      onPointerLeave={() => onHover?.(false)}
      className={cn(
        'bg-card w-44 rounded-lg border px-3 py-2.5 text-left transition-shadow',
        primary && 'border-primary border-2',
        muted && 'border-dashed',
        lit && 'ring-primary ring-2',
        flash && 'row-flash',
        focus && 'row-focus ring-primary ring-2'
      )}
    >
      <div className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
        {role}
      </div>
      <div className="truncate text-sm font-medium">{name}</div>
      <div className="text-muted-foreground mt-0.5 text-xs">
        {age === null ? <span className="text-warning">Age unknown</span> : `${age} years`}
        {' · '}
        {place ?? <span className="text-warning">Residence unknown</span>}
      </div>
      {marks && <div className="mt-1.5 flex flex-wrap gap-1 empty:hidden">{marks}</div>}
      {notes && <div className="text-muted-foreground mt-1 text-xs italic">{notes}</div>}
      {inheritance && <div className="mt-2 border-t pt-2 text-xs">{inheritance}</div>}
    </div>
  );
}

function place(residence: { city: string | null; country: string | null } | null): string | null {
  if (!residence) return null;
  const parts = [residence.city, countryName(residence.country)].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

interface FamilyViewProps {
  state: PrepState;
  changed: Set<string>;
  /** Family members recorded by the latest update: they are animated in. */
  added: Set<string>;
  /** Family members Warren is talking about right now. */
  focus: Set<string>;
  /** The item under the pointer anywhere on screen, including a meeting point about it. */
  hoverId: string | null;
  onHover: (id: string | null) => void;
  /** The death-of-the-client simulation, when it is the picture on screen. */
  simulation: Succession | null;
  settings: Settings;
}

export function FamilyView({
  state,
  changed,
  added,
  focus,
  hoverId,
  onHover,
  simulation,
  settings,
}: FamilyViewProps) {
  const currency = settings.baseCurrency;
  const { family, client } = state;
  const year = new Date().getFullYear();
  const home = client.domicile.country;
  const partners = family.members.filter((m) => PARTNER_RELATIONS.includes(m.relation));
  const exPartners = family.members.filter((m) => m.relation === 'ex_spouse');
  const children = family.members.filter((m) => m.relation === 'child');
  const others = family.members.filter(
    (m) => ![...PARTNER_RELATIONS, 'ex_spouse', 'child'].includes(m.relation)
  );
  const byId = new Map(family.members.map((m) => [m.id, m]));
  // Only say who the other parent is when the children do not all share the current partner.
  const mixedParents = exPartners.length > 0 || partners.length > 1;

  const marks = (m: FamilyMember) => {
    const age = m.birthYear === null ? null : year - m.birthYear;
    const country = m.residence?.country ?? null;
    const incomplete = !m.name || m.birthYear === null || !country;
    return (
      <>
        {country && home && country !== home && <Badge tone="info">Lives abroad</Badge>}
        {m.relation === 'child' && age !== null && age < ADULT_AGE && <Badge>Minor</Badge>}
        {incomplete && <Badge tone="warning">Details missing</Badge>}
      </>
    );
  };

  const inheritance = (m: FamilyMember) => {
    if (!simulation) return undefined;
    const heir = simulation.heirs.find((h) => h.memberId === m.id);
    const excluded = simulation.excluded.find((e) => e.memberId === m.id);
    if (!heir) {
      return (
        <span className="text-muted-foreground">
          {excluded?.reason ?? 'Not an heir under the statutory split'}
        </span>
      );
    }
    // Tax the heir's own country adds on top of what the assets trigger.
    const fromResidence = simulation.taxes.some((t) => t.layer === 'heir' && t.heirId === m.id);
    return (
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 tabular-nums">
        <dt className="text-muted-foreground">Receives</dt>
        <dd className="text-right">
          {Math.round(heir.sharePct)}% · {formatCompact(heir.gross)}
        </dd>
        <dt className="text-muted-foreground">Tax, up to</dt>
        <dd className={cn('text-right', heir.tax > 0 && 'text-danger font-medium')}>
          {formatCompact(heir.tax)}
        </dd>
        <dt className="text-muted-foreground">Net</dt>
        <dd className="text-right font-medium">{formatCompact(heir.net)}</dd>
        <dt className="text-muted-foreground">At the bank</dt>
        <dd className="text-right">{formatCompact(heir.aumAtBank)}</dd>
        {fromResidence && (
          <dd className="text-danger col-span-2 mt-0.5">
            Living in {countryName(heir.country)} adds tax
          </dd>
        )}
      </dl>
    );
  };

  const member = (m: FamilyMember, extra?: Partial<PersonProps>) => (
    <Person
      // Remounting a changed card restarts its highlight animation.
      key={changed.has(m.id) ? `${m.id}-${state.rev}` : m.id}
      itemId={m.id}
      name={m.name ?? 'Name unknown'}
      role={humanize(m.relation)}
      age={m.birthYear === null ? null : year - m.birthYear}
      place={place(m.residence)}
      notes={m.notes}
      marks={marks(m)}
      inheritance={inheritance(m)}
      flash={changed.has(m.id)}
      focus={focus.has(m.id)}
      lit={hoverId === m.id}
      onHover={(over) => onHover(over ? m.id : null)}
      {...extra}
    />
  );

  /** Motion props shared by every card's wrapper. */
  const moving = (m: FamilyMember, origin: string) => ({
    // Position only: resizing a card by scaling it would distort its connector lines.
    layout: 'position' as const,
    transition: ENTER,
    initial: added.has(m.id) ? GROW_IN : false,
    animate: SETTLED,
    style: { transformOrigin: origin },
  });

  const link = (dashed?: boolean) => (
    <div
      aria-hidden
      className={cn('w-8 self-center border-t', dashed && 'border-dashed')}
      style={{ borderColor: 'var(--tree-line)' }}
    />
  );

  return (
    <div className="space-y-5">
      <section className="bg-card rounded-lg border">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 border-b px-4 py-2 text-sm">
          <span>
            <span className="text-muted-foreground">Marital status: </span>
            {family.maritalStatus ? (
              humanize(family.maritalStatus)
            ) : (
              <span className="text-warning">Unknown</span>
            )}
          </span>
          <span>
            <span className="text-muted-foreground">Children: </span>
            {children.length > 0 ? (
              children.length
            ) : family.hasChildren === false ? (
              'None'
            ) : family.hasChildren ? (
              <span className="text-warning">Yes, no details</span>
            ) : (
              <span className="text-warning">Unknown</span>
            )}
          </span>
        </div>

        {simulation && (
          <SuccessionSummary simulation={simulation} state={state} settings={settings} />
        )}

        <div className="overflow-x-auto px-4 py-8">
          <div className="mx-auto flex w-max flex-col items-center">
            {/* Parents' generation: former partners, the client, current partner. */}
            <div className="flex items-stretch">
              {exPartners.map((m) => (
                <motion.div key={m.id} className="flex" {...moving(m, 'right center')}>
                  {member(m, { muted: true })}
                  {link(true)}
                </motion.div>
              ))}
              <motion.div layout="position" transition={SLIDE}>
                <ClientCard
                  client={client}
                  inheritance={
                    simulation && (
                      <span className="tabular-nums">
                        <span className="text-muted-foreground">Estate </span>
                        {currency} {formatNumber(simulation.estate)}
                      </span>
                    )
                  }
                />
              </motion.div>
              {partners.map((m) => (
                <motion.div key={m.id} className="flex" {...moving(m, 'left center')}>
                  {link()}
                  {member(m)}
                </motion.div>
              ))}
            </div>

            {children.length > 0 && (
              <ul className="tree-children">
                {children.map((m) => {
                  const other = m.otherParentId ? byId.get(m.otherParentId) : undefined;
                  return (
                    <motion.li key={m.id} {...moving(m, 'center top')}>
                      {member(m, {
                        role: mixedParents && other?.name ? `Child · with ${other.name}` : 'Child',
                      })}
                    </motion.li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </section>

      {others.length > 0 && (
        <section className="bg-card rounded-lg border">
          <h2 className="text-muted-foreground border-b px-4 py-2 text-xs font-medium">
            Other family members
          </h2>
          <div className="flex flex-wrap gap-3 p-4">
            {others.map((m) => (
              <motion.div key={m.id} {...moving(m, 'center')}>
                {member(m)}
              </motion.div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

interface SuccessionSummaryProps {
  simulation: Succession;
  state: PrepState;
  settings: Settings;
}

/** The headline of the split: what is passed on, what it costs, and where the bank's assets go. */
function SuccessionSummary({ simulation, state, settings }: SuccessionSummaryProps) {
  const currency = settings.baseCurrency;
  const home = state.client.domicile.country;
  const atBank = simulation.heirs.reduce((sum, h) => sum + h.aumAtBank, 0);
  const abroad = simulation.heirs
    .filter((h) => h.country && home && h.country !== home)
    .reduce((sum, h) => sum + h.aumAtBank, 0);
  const unrecorded = simulation.heirs.filter((h) => h.memberId === null);

  return (
    <div className="bg-muted/40 border-b px-4 py-3 text-sm">
      {simulation.heirsModelled ? (
        <>
          <div className="flex flex-wrap gap-x-8 gap-y-1 tabular-nums">
            <span>
              <span className="text-muted-foreground">Estate </span>
              {currency} {formatNumber(simulation.estate)}
            </span>
            <span>
              <span className="text-muted-foreground">Taxes on death, up to </span>
              <span className={cn(simulation.costHigh > 0 && 'text-danger font-medium')}>
                {currency} {formatNumber(simulation.costHigh)}
              </span>
            </span>
            <span>
              <span className="text-muted-foreground">Reaches the heirs </span>
              {currency} {formatNumber(simulation.netToHeirs)}
            </span>
          </div>
          {atBank > 0 && (
            <p className="mt-1.5">
              Of the {currency} {formatNumber(atBank)} held at {settings.houseBank},{' '}
              <span className="font-medium">
                {currency} {formatNumber(abroad)}
              </span>{' '}
              would pass to heirs living abroad.
            </p>
          )}
          {unrecorded.map((heir) => (
            <p key={heir.label} className="text-warning mt-1.5">
              {heir.label}: would receive {Math.round(heir.sharePct)}% ({currency}{' '}
              {formatNumber(heir.gross)}), but is not in the tree.
            </p>
          ))}
        </>
      ) : (
        <p>
          The heirs cannot be determined from the recorded family, so the estate of {currency}{' '}
          {formatNumber(simulation.estate)} is not split here.
        </p>
      )}
      <SimulationNote succession={simulation} className="mt-2" />
    </div>
  );
}

function ClientCard({ client, inheritance }: { client: Client; inheritance?: React.ReactNode }) {
  return (
    <Person
      name={client.name}
      role="Client"
      age={ageOn(client.dateOfBirth)}
      place={place(client.domicile)}
      inheritance={inheritance}
      primary
    />
  );
}
