'use client';

import { useEffect, useRef, useState } from 'react';
import type { IslandItem, IslandZone } from '@/components/prep/island-3d';
import { WEALTH_COLOR } from '@/components/prep/towers-3d';
import { WealthIcon } from '@/components/prep/wealth-icon';
import { cn } from '@/lib/shadcn/utils';
import { formatCompact } from '@/lib/wealth';

interface MosaicProps {
  /** The assets and the debts of the balance sheet. */
  items: IslandItem[];
  /** Captions of where the assets are held, for the legend. */
  zones: Record<IslandZone, string>;
  currency: string;
  /** What the picture shows, for screen readers. */
  description: string;
  changed: Set<string>;
  /** Items Warren is talking about right now. */
  focus: Set<string>;
  hoverId: string | null;
  onHover: (id: string | null) => void;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const ZONE_ORDER: IslandZone[] = ['bank', 'other', 'land'];
/** Half the joint between two tiles, and between two groups of tiles. */
const JOINT = 1.5;
const GROUP_JOINT = 2;

/**
 * Squarified treemap: fills the rectangle with one tile per node, each with an area in
 * proportion to its value and as close to a square as the others allow.
 */
function squarify<T>(nodes: { value: number; data: T }[], rect: Rect): { data: T; rect: Rect }[] {
  const positive = nodes.filter((node) => node.value > 0).sort((a, b) => b.value - a.value);
  const total = positive.reduce((sum, node) => sum + node.value, 0);
  if (total <= 0 || rect.w <= 0 || rect.h <= 0) return [];
  const scale = (rect.w * rect.h) / total;
  const tiles = positive.map((node) => ({ data: node.data, area: node.value * scale }));

  const placed: { data: T; rect: Rect }[] = [];
  let { x, y, w, h } = rect;
  const areaOf = (row: typeof tiles) => row.reduce((sum, tile) => sum + tile.area, 0);
  /** The worst aspect ratio in a row laid along a side of the given length. */
  const worst = (row: typeof tiles, side: number) => {
    const sum = areaOf(row);
    const largest = Math.max(...row.map((tile) => tile.area));
    const smallest = Math.min(...row.map((tile) => tile.area));
    return Math.max((side * side * largest) / (sum * sum), (sum * sum) / (side * side * smallest));
  };
  /** Lays a row along the shorter side of what is left, and takes it off. */
  const lay = (row: typeof tiles) => {
    const sum = areaOf(row);
    if (w >= h) {
      const width = sum / h;
      let top = y;
      for (const tile of row) {
        const height = tile.area / width;
        placed.push({ data: tile.data, rect: { x, y: top, w: width, h: height } });
        top += height;
      }
      x += width;
      w -= width;
    } else {
      const height = sum / w;
      let leftEdge = x;
      for (const tile of row) {
        const width = tile.area / height;
        placed.push({ data: tile.data, rect: { x: leftEdge, y, w: width, h: height } });
        leftEdge += width;
      }
      y += height;
      h -= height;
    }
  };

  let row: typeof tiles = [];
  for (const tile of tiles) {
    const side = Math.min(w, h);
    if (row.length === 0 || worst([...row, tile], side) <= worst(row, side)) {
      row.push(tile);
    } else {
      lay(row);
      row = [tile];
    }
  }
  if (row.length > 0) lay(row);
  return placed;
}

const inset = (rect: Rect, by: number): Rect => ({
  x: rect.x + by,
  y: rect.y + by,
  w: Math.max(rect.w - 2 * by, 0),
  h: Math.max(rect.h - 2 * by, 0),
});

/**
 * The balance sheet as a mosaic: one tile per asset, its area in proportion to its value, the
 * tiles of one place side by side. A debt is the hatched part of the tile of what secures it:
 * what stays plain is what the client owns of it.
 */
export function Mosaic({
  items,
  zones,
  currency,
  description,
  changed,
  focus,
  hoverId,
  onHover,
}: MosaicProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(() => setWidth(stage.clientWidth));
    observer.observe(stage);
    setWidth(stage.clientWidth);
    return () => observer.disconnect();
  }, []);
  const height = Math.round(Math.min(460, Math.max(300, width * 0.44)));

  const assets = items.filter((item) => item.kind === 'asset');
  const debts = items.filter((item) => item.kind === 'debt');
  const valued = assets.filter((asset) => (asset.value ?? 0) > 0);
  const unknown = assets.filter((asset) => !asset.value);
  const total = valued.reduce((sum, asset) => sum + (asset.value ?? 0), 0);
  const securedBy = (asset: IslandItem) => debts.filter((debt) => debt.securedBy === asset.id);
  const loose = debts.filter((debt) => !valued.some((asset) => asset.id === debt.securedBy));

  // First a tile per place, then within each the tiles of what is held there.
  const full: Rect = { x: 0, y: 0, w: width, h: height };
  const groups = squarify(
    ZONE_ORDER.map((zone) => {
      const held = valued.filter((asset) => asset.zone === zone);
      return { value: held.reduce((sum, asset) => sum + (asset.value ?? 0), 0), data: held };
    }),
    full
  );
  const tiles = groups.flatMap((group) =>
    squarify(
      group.data.map((asset) => ({ value: asset.value ?? 0, data: asset })),
      inset(group.rect, GROUP_JOINT)
    ).map((tile) => ({ asset: tile.data, rect: inset(tile.rect, JOINT) }))
  );
  /** Pixels of area per unit of currency: a debt on its own is drawn to the same scale. */
  const scale = total > 0 ? (width * height) / total : 0;

  const isLit = (id: string) => id === hoverId || focus.has(id);
  const anyLit = [...assets, ...debts].some((item) => isLit(item.id));
  const used = new Set(assets.map((asset) => asset.color));
  const legend = (
    [
      ['bank', zones.bank],
      ['other', zones.other],
      ['illiquid', zones.land],
    ] as const
  ).filter(([color]) => used.has(color));

  return (
    <div role="img" aria-label={description}>
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pt-3 text-[11px]">
        <span className="text-foreground font-semibold">Area = value</span>
        {legend.map(([color, caption]) => (
          <span key={color} className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-[2px]" style={{ background: WEALTH_COLOR[color] }} />
            {caption}
          </span>
        ))}
        {debts.length > 0 && (
          <span className="flex items-center gap-1.5">
            <span className="msc-hatch size-2.5 rounded-[2px]" />
            Owed
          </span>
        )}
      </div>

      <div className="px-4 py-3">
        <div ref={stageRef} className="relative w-full" style={{ height }} aria-hidden>
          {width > 0 &&
            tiles.map(({ asset, rect }, index) => {
              const owed = securedBy(asset);
              const owedTotal = owed.reduce((sum, debt) => sum + (debt.value ?? 0), 0);
              // What is owed on it, as the part of the tile from the bottom up.
              const owedPart = Math.min(owedTotal / (asset.value ?? 1), 1);
              const lit = isLit(asset.id) || owed.some((debt) => isLit(debt.id));
              const short = Math.min(rect.w, rect.h);
              const roomy = rect.w >= 96 && rect.h >= 62;
              const plain = rect.h * (1 - owedPart);
              return (
                <div
                  key={asset.id}
                  data-item-id={asset.id}
                  className={cn('msc-tile', changed.has(asset.id) && 'msc-changed')}
                  data-lit={lit}
                  data-dim={anyLit && !lit}
                  title={`${asset.label} · ${currency} ${formatCompact(asset.value ?? 0)}`}
                  style={
                    {
                      left: rect.x,
                      top: rect.y,
                      width: rect.w,
                      height: rect.h,
                      '--c': WEALTH_COLOR[asset.color],
                      animationDelay: `${index * 45}ms`,
                    } as React.CSSProperties
                  }
                  onPointerEnter={() => onHover(asset.id)}
                  onPointerLeave={() => onHover(null)}
                >
                  {short >= 40 && (
                    <WealthIcon
                      type={asset.type}
                      className="msc-watermark"
                      // The picture of the thing, as large as the tile lets it be.
                      style={{ width: short * 0.62, height: short * 0.62, bottom: rect.h - plain }}
                    />
                  )}
                  {rect.w >= 44 && rect.h >= 30 && (
                    <div className="relative min-w-0 p-2">
                      {roomy && (
                        <div className="flex items-center gap-1.5 text-xs font-medium">
                          <WealthIcon type={asset.type} className="size-4 shrink-0" />
                          <span className="truncate">{asset.label}</span>
                        </div>
                      )}
                      <div
                        className="leading-tight font-semibold tabular-nums"
                        style={{
                          fontSize: Math.min(30, Math.max(12, Math.sqrt(rect.w * rect.h) / 7)),
                        }}
                      >
                        {formatCompact(asset.value ?? 0)}
                      </div>
                      {roomy && (
                        <div className="text-[11px] opacity-80">
                          {Math.round(((asset.value ?? 0) / total) * 100)}% of assets
                        </div>
                      )}
                    </div>
                  )}
                  {owed.length > 0 && owedPart > 0 && (
                    <div
                      className="msc-owed"
                      style={{ height: `${owedPart * 100}%` }}
                      data-lit={owed.some((debt) => isLit(debt.id))}
                      onPointerEnter={() => onHover(owed[0].id)}
                      onPointerLeave={() => onHover(asset.id)}
                    >
                      {rect.h * owedPart >= 20 && rect.w >= 90 && (
                        <span className="msc-owed-label">
                          <span className="font-semibold tabular-nums">
                            {formatCompact(-owedTotal)}
                          </span>{' '}
                          {owed.length === 1 ? owed[0].label : `${owed.length} debts`}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          {width > 0 && tiles.length === 0 && (
            <p className="text-muted-foreground text-sm">No asset with a known value yet.</p>
          )}
        </div>

        {(loose.length > 0 || unknown.length > 0) && (
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2" aria-hidden>
            {loose.map((debt) => {
              const side = Math.max(Math.sqrt((debt.value ?? 0) * scale), 14);
              return (
                <div
                  key={debt.id}
                  data-item-id={debt.id}
                  className={cn(
                    'flex items-center gap-2 transition-opacity',
                    anyLit && !isLit(debt.id) && 'opacity-35'
                  )}
                  onPointerEnter={() => onHover(debt.id)}
                  onPointerLeave={() => onHover(null)}
                >
                  <span
                    className={cn(
                      'msc-hatch shrink-0 rounded-[4px]',
                      changed.has(debt.id) && 'msc-changed'
                    )}
                    style={{ width: side, height: side }}
                  />
                  <span className="text-xs leading-tight">
                    <span className="block font-semibold tabular-nums">
                      {debt.value === null ? '?' : formatCompact(-debt.value)}
                    </span>
                    <span className="text-muted-foreground">{debt.label}, to the same scale</span>
                  </span>
                </div>
              );
            })}
            {unknown.map((asset) => (
              <div
                key={asset.id}
                data-item-id={asset.id}
                className={cn(
                  'flex items-center gap-1.5 rounded-md border border-dashed px-2 py-1 text-xs transition-opacity',
                  isLit(asset.id) && 'bg-muted/70',
                  anyLit && !isLit(asset.id) && 'opacity-35'
                )}
                style={{ borderColor: WEALTH_COLOR[asset.color] }}
                onPointerEnter={() => onHover(asset.id)}
                onPointerLeave={() => onHover(null)}
              >
                <WealthIcon type={asset.type} className="size-4 shrink-0" />
                {asset.label}
                <span className="text-warning font-medium">value unknown</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
