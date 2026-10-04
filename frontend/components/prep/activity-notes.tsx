import { NotePencilIcon } from '@phosphor-icons/react';
import { Badge } from '@/components/prep/badge';
import { cn } from '@/lib/shadcn/utils';
import type { PrepState } from '@/lib/types';
import { formatDate } from '@/lib/wealth';

interface ActivityNotesProps {
  state: PrepState;
  hoverId: string | null;
  /** The note the review is on, if it is on one. */
  focus: Set<string>;
  onHover: (id: string | null) => void;
}

/**
 * The banker's free-text notes in the CRM. Everything else on screen comes from the CRM's
 * structured fields; what a note says and the fields do not carry is marked here and raised
 * as a meeting point.
 */
export function ActivityNotes({ state, hoverId, focus, onHover }: ActivityNotesProps) {
  const notes = state.activityNotes ?? [];
  if (notes.length === 0) return null;

  // A fact is missing from the CRM while its meeting point is open.
  const open = new Set(
    state.meetingPoints.filter((p) => p.status === 'open' && p.ruleKey).map((p) => p.ruleKey)
  );
  const missing = (factId: string) => open.has(`note.${factId}`);
  const total = notes.reduce((sum, n) => sum + n.facts.filter((f) => missing(f.id)).length, 0);

  return (
    <details
      className="bg-card group mt-5 rounded-lg border"
      open={total > 0 || notes.some((n) => focus.has(n.id))}
    >
      <summary className="flex cursor-pointer items-center justify-between gap-4 px-4 py-2 select-none">
        <span className="text-muted-foreground flex items-center gap-2 text-xs font-medium">
          <NotePencilIcon className="size-3.5" />
          CRM activity notes · {notes.length}
        </span>
        {total > 0 ? (
          <Badge tone="danger">{total} not in the CRM fields</Badge>
        ) : (
          <span className="text-muted-foreground text-xs">All reflected in the CRM fields</span>
        )}
      </summary>
      <ul className="divide-y border-t">
        {notes.map((note) => (
          <li
            key={note.id}
            data-item-id={note.id}
            onPointerEnter={() => onHover(note.id)}
            onPointerLeave={() => onHover(null)}
            className={cn(
              'px-4 py-2.5 transition-colors',
              hoverId === note.id && 'bg-muted/60',
              focus.has(note.id) && 'row-focus'
            )}
          >
            <div className="text-muted-foreground text-xs">
              {formatDate(note.date)}
              {note.author && ` · ${note.author}`}
            </div>
            <p className="mt-0.5 text-sm leading-relaxed italic">“{note.text}”</p>
            {note.facts.some((f) => missing(f.id)) && (
              <ul className="mt-1.5 space-y-1">
                {note.facts
                  .filter((f) => missing(f.id))
                  .map((fact) => (
                    <li key={fact.id} className="flex items-baseline gap-2 text-xs">
                      <Badge tone="danger">Not in the CRM fields</Badge>
                      <span>{fact.summary}</span>
                    </li>
                  ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
