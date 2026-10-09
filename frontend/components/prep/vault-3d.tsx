'use client';

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { IslandItem, IslandZone } from '@/components/prep/island-3d';
import { WEALTH_COLOR, type WealthColor } from '@/components/prep/towers-3d';
import { WealthIcon } from '@/components/prep/wealth-icon';
import { cn } from '@/lib/shadcn/utils';
import { formatCompact, formatNumber } from '@/lib/wealth';

interface Vault3DProps {
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

// --- from the balance sheet to piles of bars --------------------------------------

/** The tallest pile has at most this many bars: the unit follows from it. */
const MAX_BARS = 60;
const PER_LAYER = 3;
const BAR = { length: 0.9, width: 0.27, height: 0.15, pitch: 0.3, rise: 0.155 };
const TRAY = 0.06;
const STEP = 1.55;
/** Room kept free under the piles for their captions, and above them for the legend, in px. */
const CAPTIONS = 92;
const HEADROOM = 34;
const GROUP_GAP = 0.5;
const ZONE_ORDER: IslandZone[] = ['bank', 'other', 'land'];

/** A run of bars in a pile that belong to one item: the asset's own gold, or a debt on it. */
interface Segment {
  id: string;
  debt: boolean;
  /** How many bars, as a fraction: the last one is cut to length. */
  bars: number;
}

interface Pile {
  id: string;
  item: IslandItem;
  /** Debts secured by this asset: their bars lie at the bottom of its pile. */
  debts: IslandItem[];
  segments: Segment[];
  /** The value is not known: an empty tray. */
  unknown: boolean;
  x: number;
}

/** What one bar is worth: a round figure, so that "one bar" can be said aloud. */
function barUnit(items: IslandItem[]): number {
  const largest = Math.max(0, ...items.map((item) => item.value ?? 0));
  if (largest <= 0) return 100_000;
  const raw = largest / MAX_BARS;
  const power = 10 ** Math.floor(Math.log10(raw));
  return [1, 2.5, 5, 10].map((step) => step * power).find((unit) => unit >= raw)!;
}

/**
 * One pile per asset, in the order of the list beside it. A debt lies in the pile of what
 * secures it, as dark bars under the gold: what is left of gold is what the client owns of it.
 * A debt secured by nothing on the balance sheet is a dark pile of its own.
 */
function layoutVault(items: IslandItem[]) {
  const unit = barUnit(items);
  const assets = items.filter((item) => item.kind === 'asset');
  const debts = items.filter((item) => item.kind === 'debt');
  const assetIds = new Set(assets.map((asset) => asset.id));
  const secured = (debt: IslandItem) => !!debt.securedBy && assetIds.has(debt.securedBy);

  const piles: (Omit<Pile, 'x'> & { group: string })[] = [];
  for (const zone of ZONE_ORDER) {
    const held = assets
      .filter((asset) => asset.zone === zone)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    for (const asset of held) {
      const own = debts.filter((debt) => debt.securedBy === asset.id);
      const owed = own.map((debt) => ({ id: debt.id, debt: true, bars: (debt.value ?? 0) / unit }));
      const total = (asset.value ?? 0) / unit;
      const gold = Math.max(total - owed.reduce((sum, segment) => sum + segment.bars, 0), 0);
      piles.push({
        id: asset.id,
        item: asset,
        debts: own,
        segments: [...owed, { id: asset.id, debt: false, bars: gold }],
        unknown: asset.value === null,
        group: zone,
      });
    }
  }
  for (const debt of debts.filter((debt) => !secured(debt))) {
    piles.push({
      id: debt.id,
      item: debt,
      debts: [],
      segments: [{ id: debt.id, debt: true, bars: (debt.value ?? 0) / unit }],
      unknown: debt.value === null,
      group: 'debt',
    });
  }

  let x = 0;
  const placed: Pile[] = piles.map((pile, index) => {
    if (index > 0) x += STEP + (piles[index - 1].group === pile.group ? 0 : GROUP_GAP);
    return { ...pile, x };
  });
  for (const pile of placed) pile.x -= x / 2;
  return { piles: placed, unit, width: x + STEP };
}

/** The bars of a segment, each with its length: whole ones, then what is left over. */
function barLengths(bars: number): number[] {
  const whole = Math.floor(bars + 1e-6);
  const rest = bars - whole;
  const lengths: number[] = Array(whole).fill(1);
  if (rest >= 0.08 || (whole === 0 && bars > 0)) lengths.push(Math.max(rest, 0.22));
  return lengths;
}

// --- the scene --------------------------------------------------------------------

interface Bar {
  debt: boolean;
  /** The item the bar belongs to: an asset, or a debt lying in an asset's pile. */
  owner: string;
  pile: string;
  x: number;
  y: number;
  z: number;
  turned: boolean;
  length: number;
  /** When it drops in, in seconds since the scene started. */
  born: number;
}

const THEME = {
  day: { floor: '#eceae4', sun: 2.2, ambient: 0.7, environment: 1 },
  night: { floor: '#2a2e36', sun: 1.3, ambient: 0.45, environment: 0.7 },
};

function easeOutBounce(t: number): number {
  const n = 7.5625;
  const d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
}

function createVault(
  host: HTMLDivElement,
  labelOf: (id: string) => HTMLElement | undefined,
  onHover: (id: string | null) => void
) {
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isNight = () => document.documentElement.classList.contains('dark');
  const css = (name: string) => getComputedStyle(host).getPropertyValue(name).trim();
  const accent = (color: WealthColor) =>
    new THREE.Color(css(WEALTH_COLOR[color].slice(4, -1)) || '#888888');

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  // Gold is a mirror: without a room to reflect it is black.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, 0.04);
  scene.environment = environment.texture;

  // No perspective: a pile twice as tall is twice as tall on screen, wherever it stands.
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
  const hemisphere = new THREE.HemisphereLight('#ffffff', '#b8b2a4');
  scene.add(hemisphere);
  const sun = new THREE.DirectionalLight('#fff1d6');
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0012;
  scene.add(sun, sun.target);

  // --- what the piles are made of ---
  const ingot = new THREE.BoxGeometry(BAR.length, BAR.height, BAR.width);
  const corners = ingot.attributes.position;
  for (let i = 0; i < corners.count; i++) {
    // Narrower at the top: the trapezoid of a cast bar.
    if (corners.getY(i) > 0)
      corners.setXYZ(i, corners.getX(i) * 0.9, corners.getY(i), corners.getZ(i) * 0.7);
  }
  ingot.computeVertexNormals();
  const goldMaterial = new THREE.MeshStandardMaterial({
    color: '#f6c644',
    metalness: 1,
    roughness: 0.27,
  });
  const debtMaterial = new THREE.MeshStandardMaterial({
    color: '#4a4f5c',
    metalness: 0.85,
    roughness: 0.42,
  });
  const CAPACITY = 1200;
  const makeBars = (material: THREE.Material) => {
    const mesh = new THREE.InstancedMesh(ingot, material, CAPACITY);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.count = 0;
    mesh.frustumCulled = false;
    scene.add(mesh);
    return mesh;
  };
  const goldBars = makeBars(goldMaterial);
  const debtBars = makeBars(debtMaterial);
  let gold: Bar[] = [];
  let dark: Bar[] = [];

  const floorMaterial = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 });
  const floor = new THREE.Mesh(new THREE.BoxGeometry(1, 0.14, 2.3), floorMaterial);
  floor.position.y = -0.07;
  floor.receiveShadow = true;
  scene.add(floor);

  const trayGeometry = new THREE.BoxGeometry(1.12, TRAY, 1.12);
  const ghostGeometry = new THREE.BoxGeometry(0.92, 0.62, 0.92);
  const ghostMaterial = new THREE.MeshStandardMaterial({
    color: '#9aa3ad',
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
  });
  const trays = new THREE.Group();
  scene.add(trays);
  const trayMaterials: THREE.MeshStandardMaterial[] = [];

  let piles: Pile[] = [];
  let width = 4;
  let tallest = 1;
  let lit: { hoverId: string | null; focus: Set<string> } = { hoverId: null, focus: new Set() };
  const born = new Map<string, number>();
  const started = performance.now() / 1000;
  const clock = () => performance.now() / 1000 - started;

  const applyTheme = () => {
    const theme = isNight() ? THEME.night : THEME.day;
    floorMaterial.color.set(theme.floor);
    hemisphere.intensity = theme.ambient;
    sun.intensity = theme.sun;
    scene.environmentIntensity = theme.environment;
    for (const material of trayMaterials) {
      // A debt's own tray is iron: in its amber it would pass for gold.
      const color = material.userData.color as WealthColor;
      if (color === 'debt') material.color.set(isNight() ? '#7b8296' : '#6b7180');
      else material.color.copy(accent(color));
    }
  };

  // --- camera: a slow sway, a drag to turn ---
  const HOME = { azimuth: 0.36, polar: 1.13 };
  const view = { azimuth: HOME.azimuth, polar: HOME.polar, radius: 60, drag: 0 };
  const lookAt = new THREE.Vector3();
  const corner = new THREE.Vector3();
  /** Pixels between two piles on screen: the captions are cut to it. */
  let stepPx = 0;

  /** Fits the row and the tallest pile to the stage, whichever way the camera is turned. */
  const fit = () => {
    const widthPx = host.clientWidth;
    const heightPx = host.clientHeight;
    if (widthPx === 0 || heightPx === 0) return;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const x of [-width / 2, width / 2]) {
      for (const y of [0, tallest]) {
        for (const z of [-0.75, 0.75]) {
          corner.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
          minX = Math.min(minX, corner.x);
          maxX = Math.max(maxX, corner.x);
          minY = Math.min(minY, corner.y);
          maxY = Math.max(maxY, corner.y);
        }
      }
    }
    const perUnit = Math.min(
      (widthPx - 24) / (maxX - minX),
      (heightPx - CAPTIONS - HEADROOM) / (maxY - minY),
      // A balance sheet of one or two items does not fill the stage with them.
      70
    );
    const centre = (minX + maxX) / 2;
    camera.left = centre - widthPx / perUnit / 2;
    camera.right = centre + widthPx / perUnit / 2;
    camera.bottom = minY - CAPTIONS / perUnit;
    camera.top = camera.bottom + heightPx / perUnit;
    camera.updateProjectionMatrix();
    const step = Math.round(perUnit * STEP * Math.cos(view.azimuth));
    if (step !== stepPx) {
      stepPx = step;
      host.parentElement?.style.setProperty('--vlt-step', `${step}px`);
    }
  };

  const frameScene = () => {
    const widthPx = host.clientWidth;
    const heightPx = host.clientHeight;
    if (widthPx === 0 || heightPx === 0) return;
    renderer.setSize(widthPx, heightPx, false);
    lookAt.set(0, tallest / 2, 0);
    floor.scale.x = width + 0.9;
    sun.position.set(width * 0.25 + 3, tallest + 9, 7);
    sun.target.position.set(0, 0, 0);
    const reach = width / 2 + 3;
    sun.shadow.camera.left = -reach;
    sun.shadow.camera.right = reach;
    sun.shadow.camera.top = tallest + 4;
    sun.shadow.camera.bottom = -4;
    sun.shadow.camera.far = tallest + 40;
    sun.shadow.camera.updateProjectionMatrix();
  };
  const resizeObserver = new ResizeObserver(frameScene);
  resizeObserver.observe(host);

  const sync = (items: IslandItem[]) => {
    const layout = layoutVault(items);
    piles = layout.piles;
    width = layout.width;
    const first = born.size === 0;
    const now = clock();
    const seen = new Set<string>();
    let fresh = 0;
    gold = [];
    dark = [];
    let layers = 1;

    trays.clear();
    for (const material of trayMaterials.splice(0)) material.dispose();

    piles.forEach((pile, order) => {
      const material = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.1 });
      material.userData.color = pile.item.color;
      trayMaterials.push(material);
      const tray = new THREE.Mesh(trayGeometry, material);
      tray.position.set(pile.x, TRAY / 2, 0);
      tray.receiveShadow = true;
      tray.userData.itemId = pile.id;
      trays.add(tray);
      if (pile.unknown) {
        const ghost = new THREE.Mesh(ghostGeometry, ghostMaterial);
        ghost.position.set(pile.x, TRAY + 0.31, 0);
        ghost.userData.itemId = pile.id;
        trays.add(ghost);
      }

      let k = 0;
      for (const segment of pile.segments) {
        for (const length of barLengths(segment.bars)) {
          const layer = Math.floor(k / PER_LAYER);
          const offset = ((k % PER_LAYER) - 1) * BAR.pitch;
          // Each layer lies across the one below, as bars are stacked.
          const turned = layer % 2 === 1;
          const key = `${pile.id}:${k}`;
          seen.add(key);
          if (!born.has(key)) {
            born.set(
              key,
              still ? -10 : first ? 0.25 + order * 0.12 + k * 0.028 : now + fresh++ * 0.05
            );
          }
          (segment.debt ? dark : gold).push({
            debt: segment.debt,
            owner: segment.id,
            pile: pile.id,
            x: pile.x + (turned ? offset : 0),
            y: TRAY + BAR.height / 2 + layer * BAR.rise,
            z: turned ? 0 : offset,
            turned,
            length,
            born: born.get(key)!,
          });
          layers = Math.max(layers, layer + 1);
          k++;
        }
      }
    });
    for (const key of [...born.keys()]) if (!seen.has(key)) born.delete(key);
    goldBars.count = Math.min(gold.length, CAPACITY);
    debtBars.count = Math.min(dark.length, CAPACITY);
    tallest = TRAY + layers * BAR.rise;
    applyTheme();
    frameScene();
  };

  // --- pointer ---
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let pointerInside = false;
  let pointerMoved = false;
  let dragging: { x: number; y: number; azimuth: number; polar: number } | null = null;
  let hovered: string | null = null;

  const onPointerMove = (event: PointerEvent) => {
    const rect = host.getBoundingClientRect();
    pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    pointerInside = true;
    pointerMoved = true;
    if (dragging) {
      view.drag = Math.max(
        -0.9,
        Math.min(0.9, dragging.azimuth - (event.clientX - dragging.x) * 0.006)
      );
      view.polar = Math.max(
        0.75,
        Math.min(1.45, dragging.polar - (event.clientY - dragging.y) * 0.004)
      );
    }
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    dragging = { x: event.clientX, y: event.clientY, azimuth: view.drag, polar: view.polar };
    if (event.pointerType === 'mouse') host.setPointerCapture(event.pointerId);
    host.dataset.dragging = 'true';
  };
  const onPointerUp = () => {
    dragging = null;
    delete host.dataset.dragging;
  };
  const onPointerLeave = () => {
    pointerInside = false;
    if (hovered !== null) {
      hovered = null;
      onHover(null);
    }
  };
  host.addEventListener('pointermove', onPointerMove);
  host.addEventListener('pointerdown', onPointerDown);
  host.addEventListener('pointerup', onPointerUp);
  host.addEventListener('pointercancel', onPointerUp);
  host.addEventListener('pointerleave', onPointerLeave);

  const pick = () => {
    if (!pointerInside || dragging) return;
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects([goldBars, debtBars, trays], true)[0];
    let id: string | null = null;
    if (hit?.object === goldBars) id = gold[hit.instanceId!]?.owner ?? null;
    else if (hit?.object === debtBars) id = dark[hit.instanceId!]?.owner ?? null;
    else if (hit) id = (hit.object.userData.itemId as string | undefined) ?? null;
    if (id !== hovered) {
      hovered = id;
      onHover(id);
    }
    host.style.cursor = id ? 'pointer' : '';
  };

  // --- the frame ---
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const flat = new THREE.Quaternion();
  const across = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  const tint = new THREE.Color();
  const projected = new THREE.Vector3();

  const draw = (mesh: THREE.InstancedMesh, bars: Bar[], time: number, anyLit: boolean) => {
    const isLit = (id: string) => id === lit.hoverId || lit.focus.has(id);
    for (let i = 0; i < mesh.count; i++) {
      const bar = bars[i];
      const age = (time - bar.born) / 0.6;
      const landed = age >= 1 ? 1 : age <= 0 ? 0 : easeOutBounce(age);
      position.set(bar.x, bar.y + (1 - landed) * 3.2, bar.z);
      scale.set(bar.length, 1, 1).multiplyScalar(age <= 0 ? 0.0001 : 1);
      mesh.setMatrixAt(i, matrix.compose(position, bar.turned ? across : flat, scale));
      // What is lit keeps its colour; the rest steps back.
      const on = isLit(bar.owner) || isLit(bar.pile);
      mesh.setColorAt(i, tint.setScalar(anyLit && !on ? 0.32 : 1));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  };

  let frame = 0;
  let last = performance.now() / 1000;
  let visible = true;
  const visibility = new IntersectionObserver(([entry]) => (visible = entry.isIntersecting));
  visibility.observe(host);

  const render = () => {
    frame = requestAnimationFrame(render);
    if (!visible || document.hidden) return;
    const now = performance.now() / 1000;
    const dt = Math.min(now - last, 0.05);
    last = now;
    const time = clock();

    const ids = new Set<string>();
    for (const pile of piles) {
      ids.add(pile.id);
      for (const debt of pile.debts) ids.add(debt.id);
    }
    const anyLit = [...ids].some((id) => id === lit.hoverId || lit.focus.has(id));

    const sway = still || dragging || anyLit ? 0 : Math.sin(time * 0.3) * 0.05;
    const goal = HOME.azimuth + view.drag + sway;
    view.azimuth += (goal - view.azimuth) * (still ? 1 : 1 - Math.exp(-dt * 6));
    camera.position.set(
      lookAt.x + view.radius * Math.sin(view.polar) * Math.sin(view.azimuth),
      lookAt.y + view.radius * Math.cos(view.polar),
      lookAt.z + view.radius * Math.sin(view.polar) * Math.cos(view.azimuth)
    );
    camera.lookAt(lookAt);
    camera.updateMatrixWorld();
    fit();

    draw(goldBars, gold, time, anyLit);
    draw(debtBars, dark, time, anyLit);

    // Each caption hangs under the front of its pile.
    for (const pile of piles) {
      const label = labelOf(pile.id);
      if (!label) continue;
      projected.set(pile.x, 0, 0.66).project(camera);
      label.style.transform = `translate(-50%, 0) translate(${((projected.x + 1) / 2) * host.clientWidth}px, ${((1 - projected.y) / 2) * host.clientHeight + 6}px)`;
      label.style.visibility = 'visible';
    }

    if (pointerMoved) {
      pointerMoved = false;
      pick();
    }
    renderer.render(scene, camera);
  };
  frame = requestAnimationFrame(render);

  const themeObserver = new MutationObserver(applyTheme);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

  return {
    sync,
    setLit: (next: typeof lit) => (lit = next),
    dispose: () => {
      cancelAnimationFrame(frame);
      themeObserver.disconnect();
      resizeObserver.disconnect();
      visibility.disconnect();
      host.removeEventListener('pointermove', onPointerMove);
      host.removeEventListener('pointerdown', onPointerDown);
      host.removeEventListener('pointerup', onPointerUp);
      host.removeEventListener('pointercancel', onPointerUp);
      host.removeEventListener('pointerleave', onPointerLeave);
      for (const material of trayMaterials) material.dispose();
      for (const thing of [
        ingot,
        goldMaterial,
        debtMaterial,
        floor.geometry,
        floorMaterial,
        trayGeometry,
        ghostGeometry,
        ghostMaterial,
        goldBars,
        debtBars,
        environment,
        pmrem,
      ]) {
        thing.dispose();
      }
      room.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

/**
 * The balance sheet as a vault: everything is gold bars of one size, one pile per asset, so
 * that a taller pile is simply more money. A debt is dark bars at the bottom of the pile of
 * what secures it: the gold above them is what the client owns of it.
 */
export function Vault3D({
  items,
  zones,
  currency,
  description,
  changed,
  focus,
  hoverId,
  onHover,
}: Vault3DProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const labels = useRef(new Map<string, HTMLElement>());
  const vaultRef = useRef<ReturnType<typeof createVault> | null>(null);
  const onHoverRef = useRef(onHover);
  onHoverRef.current = onHover;

  useEffect(() => {
    if (!hostRef.current) return;
    const vault = createVault(
      hostRef.current,
      (id) => labels.current.get(id),
      (id) => onHoverRef.current(id)
    );
    vaultRef.current = vault;
    return () => {
      vaultRef.current = null;
      vault.dispose();
    };
  }, []);

  // Rebuilt only when what is in the vault changes, not on every hover.
  const signature = JSON.stringify(items);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const layout = useMemo(() => layoutVault(items), [signature]);
  useEffect(() => {
    vaultRef.current?.sync(items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  useEffect(() => {
    vaultRef.current?.setLit({ hoverId, focus });
  }, [hoverId, focus]);

  const isLit = (id: string) => id === hoverId || focus.has(id);
  const anyLit = layout.piles.some((pile) => isLit(pile.id) || pile.debts.some((d) => isLit(d.id)));
  const active = items.find((item) => item.id === hoverId) ?? null;
  const used = new Set(layout.piles.map((pile) => pile.item.color));
  const legend = (
    [
      ['bank', zones.bank],
      ['other', zones.other],
      ['illiquid', zones.land],
    ] as const
  ).filter(([color]) => used.has(color));
  const hasDebt = items.some((item) => item.kind === 'debt');

  return (
    <div className="isl-stage vlt-stage" role="img" aria-label={description}>
      <div ref={hostRef} className="isl-canvas" />
      <div className="isl-overlay" aria-hidden>
        {layout.piles.map((pile) => {
          const { item } = pile;
          const lit = isLit(pile.id) || pile.debts.some((debt) => isLit(debt.id));
          return (
            <div
              key={pile.id}
              ref={(element) => {
                if (element) labels.current.set(pile.id, element);
                else labels.current.delete(pile.id);
              }}
              className={cn('vlt-label', changed.has(pile.id) && 'vlt-changed')}
              data-lit={lit}
              data-dim={anyLit && !lit}
              style={{ '--c': WEALTH_COLOR[item.color] } as React.CSSProperties}
              onPointerEnter={() => onHover(pile.id)}
              onPointerLeave={() => onHover(null)}
            >
              <div className="vlt-label-value">
                <WealthIcon type={item.type} className="size-4 shrink-0" />
                {item.value === null ? (
                  <span className="text-warning">?</span>
                ) : (
                  <span>{formatCompact(item.kind === 'debt' ? -item.value : item.value)}</span>
                )}
              </div>
              <div className="vlt-label-name">{item.label}</div>
              {pile.debts.map((debt) => (
                <div
                  key={debt.id}
                  className={cn('vlt-label-debt', changed.has(debt.id) && 'vlt-changed')}
                  data-lit={isLit(debt.id)}
                  onPointerEnter={() => onHover(debt.id)}
                  onPointerLeave={() => onHover(pile.id)}
                >
                  <span className="vlt-swatch-debt" />
                  {debt.value === null ? '?' : formatCompact(-debt.value)}
                  <span className="vlt-label-debt-name">{debt.label}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
      <div className="vlt-legend" aria-hidden>
        <span className="vlt-legend-unit">
          <span className="vlt-swatch-gold" />1 bar = {currency} {formatCompact(layout.unit)}
        </span>
        {legend.map(([color, caption]) => (
          <span key={color}>
            <span className="vlt-swatch" style={{ background: WEALTH_COLOR[color] }} />
            {caption}
          </span>
        ))}
        {hasDebt && (
          <span>
            <span className="vlt-swatch-debt" />
            Owed
          </span>
        )}
      </div>
      <div className="isl-hint" aria-hidden>
        Drag to turn
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
              {active.value === null
                ? 'Value unknown'
                : `${currency} ${formatNumber(active.value)} · ${(active.value / layout.unit).toFixed(1)} bars`}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
