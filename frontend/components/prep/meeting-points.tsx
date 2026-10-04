import { Badge } from '@/components/prep/badge';
import { cn } from '@/lib/shadcn/utils';
import type { MeetingPoint, PointKind, Section } from '@/lib/types';

export const KIND: Record<
  PointKind,
  { label: string; tone: 'warning' | 'danger' | 'info' | 'neutral' }
> = {
  missing: { label: 'Missing', tone: 'warning' },
  inconsistency: { label: 'Inconsistent', tone: 'danger' },
  plausibility: { label: 'To verify', tone: 'danger' },
  topic: { label: 'Topic', tone: 'info' },
  inefficiency: { label: 'Cost of inaction', tone: 'danger' },
};

export const SECTIONS: { id: Section; label: string }[] = [
  { id: 'wealth', label: 'Wealth' },
  { id: 'family', label: 'Family' },
  { id: 'general', label: 'General' },
];

/** Names of the bank experts, as the rules give them; the id until the rules have loaded. */
export type ExpertLabels = Record<string, string>;

interface MeetingPointsProps {
  experts: ExpertLabels;
  points: MeetingPoint[];
  changed: Set<string>;
  rev: number;
  /** False until the agent has sent the state; the points are computed by the agent. */
  live: boolean;
  /** The item under the pointer anywhere on screen: its points light up here. */
  hoverId: string | null;
  /** Items Warren is talking about right now. */
  focus: Set<string>;
  onHover: (id: string | null) => void;
  /** Show the part of the screen the point is about. */
  onSelect: (point: MeetingPoint) => void;
}

export function MeetingPoints({
  experts,
  points,
  changed,
  rev,
  live,
  hoverId,
  focus,
  onHover,
  onSelect,
}: MeetingPointsProps) {
  const open = points.filter((p) => p.status === 'open');
  const closed = points.length - open.length;

  if (!live) {
    return (
      <p className="text-muted-foreground p-4 text-sm">
        The points to raise in the meeting appear here once the conversation with Warren starts.
      </p>
    );
  }

  return (
    <div className="space-y-4 p-4">
      {SECTIONS.map(({ id, label }) => {
        const items = open.filter((p) => p.section === id);
        if (items.length === 0) return null;
        return (
          <div key={id}>
            <h3 className="text-muted-foreground mb-1.5 text-xs font-medium">
              {label} · {items.length}
            </h3>
            <ul className="space-y-1.5">
              {items.map((point) => {
                const isChanged = changed.has(point.id);
                const item = point.relatedItemId;
                const lit = item !== null && item === hoverId;
                const spoken = item !== null && focus.has(item);
                return (
                  <li key={isChanged ? `${point.id}-${rev}` : point.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(point)}
                      onPointerEnter={() => onHover(item)}
                      onPointerLeave={() => onHover(null)}
                      className={cn(
                        'w-full rounded-md border px-3 py-2 text-left transition-colors',
                        id === 'general' ? 'cursor-default' : 'hover:bg-muted/50 cursor-pointer',
                        lit && 'border-primary bg-primary/5',
                        isChanged && 'row-flash',
                        spoken && 'row-focus'
                      )}
                    >
                      <Badge tone={KIND[point.kind].tone}>{KIND[point.kind].label}</Badge>
                      <p className="mt-1 text-sm leading-snug">{point.text}</p>
                      {point.expert && (
                        <p className="text-muted-foreground mt-1 text-xs">
                          Involve: {experts[point.expert] ?? point.expert}
                        </p>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      {open.length === 0 && <p className="text-muted-foreground text-sm">No open points.</p>}
      {closed > 0 && (
        <p className="text-muted-foreground text-xs">
          {closed} {closed === 1 ? 'point' : 'points'} closed during this session.
        </p>
      )}
    </div>
  );
}
