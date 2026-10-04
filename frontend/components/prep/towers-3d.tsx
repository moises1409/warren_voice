'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/shadcn/utils';
import { formatNumber } from '@/lib/wealth';

/**
 * Colours of the parts of the wealth picture. Each pair that can sit next to each other in a
 * tower was validated for colour-vision deficiency, in both themes.
 */
export const WEALTH_COLOR = {
  bank: 'var(--wealth-bank)',
  other: 'var(--wealth-other)',
  illiquid: 'var(--wealth-illiquid)',
  debt: 'var(--wealth-debt)',
  net: 'var(--wealth-net)',
  income: 'var(--wealth-bank)',
  expense: 'var(--wealth-other)',
  surplus: 'var(--wealth-illiquid)',
  shortfall: 'var(--wealth-debt)',
  tax: 'var(--wealth-tax)',
  heirs: 'var(--wealth-net)',
} as const;

export type WealthColor = keyof typeof WEALTH_COLOR;

export interface Block {
  id: string;
  color: WealthColor;
  label: string;
  /** In base currency. */
  value: number;
}

const TOWER_HEIGHT = 200;
const MIN_BLOCK = 5;
const GAP = 2;

/** Heights in px that add up to the tower's share of TOWER_HEIGHT, however small a block is. */
function layout(blocks: Block[], scale: number): number[] {
  const target = blocks.reduce((sum, b) => sum + b.value, 0) * scale;
  const raw = blocks.map((b) => Math.max(b.value * scale, MIN_BLOCK));
  const gaps = Math.max(blocks.length - 1, 0) * GAP;
  const extra = raw.reduce((sum, h) => sum + h, 0) + gaps - target;
  if (extra <= 0) return raw;
  // Take the excess from the blocks that can spare it, in proportion.
  const spare = raw.reduce((sum, h) => sum + Math.max(h - MIN_BLOCK, 0), 0);
  return raw.map((h) => h - (spare > 0 ? (Math.max(h - MIN_BLOCK, 0) / spare) * extra : 0));
}

interface TowerProps {
  title: string;
  blocks: Block[];
  scale: number;
  grown: boolean;
  /** Something in the picture is lit, so the rest steps back. */
  dimOthers: boolean;
  hoverId: string | null;
  focus: Set<string>;
  changed: Set<string>;
  onHover: (id: string | null) => void;
}

function Tower({
  title,
  blocks,
  scale,
  grown,
  dimOthers,
  hoverId,
  focus,
  changed,
  onHover,
}: TowerProps) {
  const heights = layout(blocks, scale);
  return (
    <div className="b3d-tower">
      {blocks.map((block, index) => {
        const lit = block.id === hoverId || focus.has(block.id);
        return (
          <div
            key={block.id}
            className={cn(
              'b3d-block',
              lit && 'is-lit',
              focus.has(block.id) && 'is-focus',
              changed.has(block.id) && 'is-changed',
              dimOthers && !lit && 'is-dim'
            )}
            style={
              {
                height: grown ? heights[index] : 0,
                '--c': WEALTH_COLOR[block.color],
              } as React.CSSProperties
            }
            onPointerEnter={() => onHover(block.id)}
            onPointerLeave={() => onHover(null)}
          >
            <div className="b3d-face b3d-front" />
            <div className="b3d-face b3d-right" />
            <div className="b3d-face b3d-left" />
            <div className="b3d-face b3d-top" />
          </div>
        );
      })}
      <div className="b3d-caption">{title}</div>
    </div>
  );
}

interface Towers3DProps {
  left: { title: string; blocks: Block[] };
  right: { title: string; blocks: Block[] };
  currency: string;
  /** What the picture shows, for screen readers. */
  description: string;
  changed: Set<string>;
  /** Items Warren is talking about right now. */
  focus: Set<string>;
  hoverId: string | null;
  onHover: (id: string | null) => void;
}

/**
 * Two towers of blocks on a common scale, one block per item. Used where the two sides add up
 * to the same total: assets against debt plus net worth, income against expenses plus surplus.
 */
export function Towers3D({
  left,
  right,
  currency,
  description,
  changed,
  focus,
  hoverId,
  onHover,
}: Towers3DProps) {
  const sceneRef = useRef<HTMLDivElement>(null);

  // Grow the towers from the floor on first paint.
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  const sum = (blocks: Block[]) => blocks.reduce((total, b) => total + b.value, 0);
  const tallest = Math.max(sum(left.blocks), sum(right.blocks));
  const scale = tallest > 0 ? TOWER_HEIGHT / tallest : 0;
  const active = [...left.blocks, ...right.blocks].find((b) => b.id === hoverId) ?? null;
  // The rest steps back only when what is lit is one of these blocks: a highlight on
  // something that has no block here, such as an activity note, must not grey the picture.
  const dimOthers = [...left.blocks, ...right.blocks].some(
    (b) => b.id === hoverId || focus.has(b.id)
  );
  const shared = { scale, grown, dimOthers, hoverId, focus, changed, onHover };

  // Tilt the scene towards the pointer. Written straight to the element: no re-render per move.
  const tilt = (event: React.PointerEvent<HTMLDivElement>) => {
    const scene = sceneRef.current;
    if (!scene) return;
    const box = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width - 0.5;
    const y = (event.clientY - box.top) / box.height - 0.5;
    scene.style.setProperty('--ry', `${-26 + x * 26}deg`);
    scene.style.setProperty('--rx', `${-13 - y * 8}deg`);
  };
  const settle = () => {
    sceneRef.current?.style.removeProperty('--ry');
    sceneRef.current?.style.removeProperty('--rx');
  };

  return (
    <div
      className="b3d-stage"
      onPointerMove={tilt}
      onPointerLeave={settle}
      role="img"
      aria-label={description}
    >
      <div ref={sceneRef} className="b3d-scene">
        <div className="b3d-floor" />
        <Tower title={left.title} blocks={left.blocks} {...shared} />
        <Tower title={right.title} blocks={right.blocks} {...shared} />
      </div>
      <div className="b3d-tooltip" aria-hidden data-visible={active !== null}>
        {active && (
          <>
            <span
              className="size-2.5 shrink-0 rounded-[3px]"
              style={{ background: WEALTH_COLOR[active.color] }}
            />
            <span className="truncate">{active.label}</span>
            <span className="font-medium tabular-nums">
              {currency} {formatNumber(active.value)}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
