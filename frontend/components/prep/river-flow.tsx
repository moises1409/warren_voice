'use client';

import { useEffect, useRef, useState } from 'react';
import { WEALTH_COLOR, type WealthColor } from '@/components/prep/towers-3d';
import { WealthIcon } from '@/components/prep/wealth-icon';
import { cn } from '@/lib/shadcn/utils';
import { formatCompact, formatNumber } from '@/lib/wealth';

export interface RiverNode {
  id: string;
  /** The type of the cash flow, which picks its icon. */
  type: string;
  color: WealthColor;
  label: string;
  /** Per year, in base currency; null when the amount is not known. */
  value: number | null;
}

interface RiverFlowProps {
  /** Where the money comes from, including what capital has to add in a year of shortfall. */
  sources: RiverNode[];
  /** Where it goes, including what is left over in a year of surplus. */
  uses: RiverNode[];
  currency: string;
  /** What the picture shows, for screen readers. */
  description: string;
  changed: Set<string>;
  /** Items Warren is talking about right now. */
  focus: Set<string>;
  hoverId: string | null;
  onHover: (id: string | null) => void;
}

/** Height of the river where everything runs together. */
const TRUNK = 170;
const MIN_BRANCH = 3;
/** Room a caption needs, however thin its branch. */
const SLOT = 44;
const GAP = 8;
const PADDING = 26;
const COIN_SECONDS = 2.8;

interface Branch {
  node: RiverNode;
  height: number;
  /** Centre of the branch at its caption, and where it joins the river. */
  outer: number;
  inner: number;
}

/** Stacks one side: spread out at the captions, packed together where it meets the river. */
function stack(nodes: RiverNode[], total: number) {
  const heights = nodes.map((node) =>
    node.value ? Math.max((node.value / total) * TRUNK, MIN_BRANCH) : MIN_BRANCH
  );
  const slots = heights.map((height) => Math.max(height, SLOT));
  const column = slots.reduce((sum, slot) => sum + slot, 0) + GAP * Math.max(nodes.length - 1, 0);
  const trunk = heights.reduce((sum, height) => sum + height, 0);
  return { heights, slots, column, trunk };
}

function place(nodes: RiverNode[], side: ReturnType<typeof stack>, height: number): Branch[] {
  let outer = (height - side.column) / 2;
  let inner = (height - side.trunk) / 2;
  return nodes.map((node, i) => {
    const branch = {
      node,
      height: side.heights[i],
      outer: outer + side.slots[i] / 2,
      inner: inner + side.heights[i] / 2,
    };
    outer += side.slots[i] + GAP;
    inner += side.heights[i];
    return branch;
  });
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const listen = () => setReduced(query.matches);
    query.addEventListener('change', listen);
    return () => query.removeEventListener('change', listen);
  }, []);
  return reduced;
}

/**
 * Income and expenses as a river: every source is a tributary as wide as its amount, they run
 * together, and the river parts again into what the money is spent on and what is left over.
 */
export function RiverFlow({
  sources,
  uses,
  currency,
  description,
  changed,
  focus,
  hoverId,
  onHover,
}: RiverFlowProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const still = useReducedMotion();
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(() => setWidth(stage.clientWidth));
    observer.observe(stage);
    setWidth(stage.clientWidth);
    return () => observer.disconnect();
  }, []);

  const sum = (nodes: RiverNode[]) => nodes.reduce((total, node) => total + (node.value ?? 0), 0);
  const total = Math.max(sum(sources), sum(uses), 1);
  const left = stack(sources, total);
  const right = stack(uses, total);
  const height = Math.max(left.column, right.column, TRUNK) + PADDING * 2;
  const from = place(sources, left, height);
  const to = place(uses, right, height);

  // Across: caption, tributaries, the river, branches, caption.
  const caption = Math.min(230, Math.max(128, width * 0.25));
  const x0 = caption + 22;
  const x3 = width - caption - 22;
  const x1 = width / 2 - 44;
  const x2 = width / 2 + 44;
  const trunkTop = Math.min((height - left.trunk) / 2, (height - right.trunk) / 2);
  const trunkBottom = Math.max((height + left.trunk) / 2, (height + right.trunk) / 2);

  const isLit = (id: string) => id === hoverId || focus.has(id);
  const anyLit = [...sources, ...uses].some((node) => isLit(node.id));

  const curve = (xa: number, ya: number, xb: number, yb: number) => {
    const middle = (xa + xb) / 2;
    return `M ${xa} ${ya} C ${middle} ${ya}, ${middle} ${yb}, ${xb} ${yb}`;
  };

  const branch = ({ node, height: thickness, outer, inner }: Branch, incoming: boolean) => {
    const path = incoming ? curve(x0, outer, x1 + 2, inner) : curve(x2 - 2, inner, x3, outer);
    const lit = isLit(node.id);
    const coins = node.value ? Math.max(1, Math.min(7, Math.round((node.value / total) * 12))) : 0;
    return (
      <g
        key={node.id}
        onPointerEnter={() => onHover(node.id)}
        onPointerLeave={() => onHover(null)}
        className="transition-opacity"
        opacity={anyLit && !lit ? 0.25 : 1}
      >
        <path
          d={path}
          fill="none"
          stroke={WEALTH_COLOR[node.color]}
          strokeWidth={thickness}
          strokeDasharray={node.value ? undefined : '5 5'}
          opacity={lit ? 1 : 0.78}
        />
        {/* A thin branch is hard to point at: a wider, unseen one takes the pointer. */}
        <path d={path} fill="none" stroke="transparent" strokeWidth={Math.max(thickness, 16)} />
        {!still &&
          Array.from({ length: coins }, (_, i) => (
            <circle key={i} r={3.4} className="rvr-coin">
              <animateMotion
                dur={`${COIN_SECONDS}s`}
                begin={`${-(i / coins) * COIN_SECONDS - (incoming ? 0 : COIN_SECONDS / 2)}s`}
                repeatCount="indefinite"
                path={path}
              />
            </circle>
          ))}
      </g>
    );
  };

  const captionOf = ({ node, outer }: Branch, incoming: boolean) => {
    const lit = isLit(node.id);
    return (
      <div
        key={node.id}
        data-item-id={node.id}
        onPointerEnter={() => onHover(node.id)}
        onPointerLeave={() => onHover(null)}
        className={cn(
          'absolute flex items-center gap-2 rounded-md px-1.5 transition-[opacity,background-color]',
          incoming ? 'flex-row-reverse text-right' : 'text-left',
          lit && 'bg-muted/70',
          anyLit && !lit && 'opacity-35',
          changed.has(node.id) && 'row-flash',
          focus.has(node.id) && 'row-focus'
        )}
        style={{
          top: outer - SLOT / 2,
          height: SLOT,
          width: caption + 14,
          left: incoming ? 0 : x3 + 8,
        }}
      >
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-full text-white"
          style={{ background: WEALTH_COLOR[node.color] }}
        >
          <WealthIcon type={node.type} className="size-[18px]" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm leading-tight">{node.label}</span>
          {node.value === null ? (
            <span className="text-warning block text-xs">unknown</span>
          ) : (
            <span className="block text-sm leading-tight font-semibold tabular-nums">
              {formatCompact(node.value)}
              <span className="text-muted-foreground ml-1.5 text-xs font-normal">
                {Math.round((node.value / total) * 100)}%
              </span>
            </span>
          )}
        </span>
      </div>
    );
  };

  return (
    <div
      ref={stageRef}
      className="relative w-full overflow-hidden"
      style={{ height }}
      role="img"
      aria-label={description}
    >
      {width > 0 && (
        <>
          <svg width={width} height={height} className="absolute inset-0">
            <defs>
              <linearGradient id="rvr-trunk" x1="0" x2="1" y1="0" y2="0">
                <stop offset="0" stopColor={WEALTH_COLOR.income} />
                <stop offset="1" stopColor={WEALTH_COLOR.expense} />
              </linearGradient>
            </defs>
            {from.map((item) => branch(item, true))}
            {to.map((item) => branch(item, false))}
            <rect
              x={x1}
              y={trunkTop}
              width={x2 - x1}
              height={trunkBottom - trunkTop}
              rx={6}
              fill="url(#rvr-trunk)"
              opacity={anyLit ? 0.45 : 0.85}
              className="transition-opacity"
            />
          </svg>
          <div
            className="text-muted-foreground pointer-events-none absolute text-center text-[11px] leading-tight"
            style={{ left: x1 - 30, width: x2 - x1 + 60, top: Math.max(trunkTop - 34, 2) }}
          >
            <span className="text-foreground block text-xs font-semibold tabular-nums">
              {currency} {formatNumber(total)}
            </span>
            a year
          </div>
          {from.map((item) => captionOf(item, true))}
          {to.map((item) => captionOf(item, false))}
        </>
      )}
    </div>
  );
}
