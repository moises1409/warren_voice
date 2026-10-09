'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { WEALTH_COLOR, type WealthColor } from '@/components/prep/towers-3d';
import { formatCompact, formatNumber } from '@/lib/wealth';

/** Where on the island an item stands: the two banks of the river, or the land behind them. */
export type IslandZone = 'bank' | 'other' | 'land';

export interface IslandItem {
  id: string;
  /** A store is what the year leaves over, or what it lacks: it stands in the pond. */
  kind: 'asset' | 'debt' | 'income' | 'expense' | 'store';
  /** The type of the asset, debt or flow, which decides what is built: a house, a tower, gold. */
  type: string;
  zone: IslandZone | 'pond';
  color: WealthColor;
  label: string;
  /** In base currency; null when the value is not known. */
  value: number | null;
  /** For a debt: the asset it is chained to. */
  securedBy?: string | null;
}

interface Island3DProps {
  items: IslandItem[];
  /** Captions of the zones in use. */
  zones: Partial<Record<IslandZone, string>>;
  currency: string;
  /** What the picture shows, for screen readers. */
  description: string;
  changed: Set<string>;
  /** Items Warren is talking about right now. */
  focus: Set<string>;
  hoverId: string | null;
  onHover: (id: string | null) => void;
}

// --- the ground plan ------------------------------------------------------------

const ISLAND = { halfWidth: 5.0, halfDepth: 3.9 };
const ZONES: Record<IslandZone, { x0: number; x1: number; z0: number; z1: number }> = {
  land: { x0: -4.5, x1: 4.5, z0: -3.5, z1: -1.7 },
  bank: { x0: -4.6, x1: -0.8, z0: -0.5, z1: 3.4 },
  other: { x0: 0.8, x1: 4.6, z0: -0.5, z1: 3.4 },
};
/** The captions hang on the cliff under each zone, like signs. */
const ZONE_ANCHOR: Record<IslandZone, [number, number, number]> = {
  land: [5.05, -0.45, -2.6],
  bank: [-2.7, -0.45, 3.95],
  other: [2.7, -0.45, 3.95],
};
const POND = { x: 0, z: -0.75 };
/** What stands for each kind of income and expense. */
const FLOW_MODEL: Record<string, string> = {
  salary: 'office',
  bonus: 'office',
  dividend: 'business_stake',
  business_income: 'business_stake',
  rental: 'real_estate',
  living_costs: 'real_estate',
  taxes: 'taxes',
};
/** Coins in the air at any time, shared between the flows by their amounts. */
const COINS = 46;
/** The room a full-size building needs. */
const CELL = 2.1;
const UNKNOWN_SCALE = 0.6;

const PALETTE = {
  day: {
    grass: '#8fca6b',
    grassEdge: '#79b757',
    earth: ['#a9794f', '#8f6340', '#754f33'],
    water: '#5cc0ee',
    wall: '#f4ecdc',
    roof: '#c8553d',
    brick: '#b9684a',
    stone: '#e7e2d6',
    glass: '#cfe3f5',
    gold: '#f0bb3c',
    iron: '#3b3f48',
    cloud: '#ffffff',
    sky: '#ffffff',
    ground: '#b9d7a0',
    sun: 2.4,
    ambient: 1.25,
    glow: 0,
  },
  night: {
    grass: '#4f8f5b',
    grassEdge: '#437c4e',
    earth: ['#5b4334', '#4a362a', '#3a2a21'],
    water: '#2f7fb5',
    wall: '#b9b3a6',
    roof: '#8e4334',
    brick: '#7d4a38',
    stone: '#a5a196',
    glass: '#6f8aa6',
    gold: '#e0a92e',
    iron: '#23262d',
    cloud: '#6d7890',
    sky: '#9db4e0',
    ground: '#3a5a40',
    sun: 1.7,
    ambient: 1.35,
    glow: 1,
  },
} as const;

type Palette = (typeof PALETTE)['day'] | (typeof PALETTE)['night'];
type PaletteKey = Exclude<keyof Palette, 'earth' | 'sun' | 'ambient' | 'glow'>;

// --- building the models ----------------------------------------------------------

interface Model {
  group: THREE.Group;
  /** Height of the model at scale 1, where its label floats. */
  height: number;
  /** Moves the parts that live: smoke, a spinning coin. */
  tick?: (time: number) => void;
}

/**
 * Makes the models of one scene. Materials are shared by palette key, so a change of theme
 * recolours every building at once.
 */
function createKit(accent: (color: WealthColor) => THREE.Color) {
  const themed = new Map<string, { material: THREE.MeshStandardMaterial; key: PaletteKey }>();
  const lamps: THREE.MeshStandardMaterial[] = [];
  const accents = new Map<WealthColor, THREE.MeshStandardMaterial[]>();
  const disposables: { dispose: () => void }[] = [];

  const track = <T extends { dispose: () => void }>(thing: T): T => {
    disposables.push(thing);
    return thing;
  };

  const themedMaterial = (key: PaletteKey, extra: THREE.MeshStandardMaterialParameters = {}) => {
    const id = `${key}:${JSON.stringify(extra)}`;
    let entry = themed.get(id);
    if (!entry) {
      const material = track(
        new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.85, ...extra })
      );
      entry = { material, key };
      themed.set(id, entry);
    }
    return entry.material;
  };

  /** A material in one of the wealth colours: what ties a building to its line in the list. */
  const accentMaterial = (color: WealthColor, extra: THREE.MeshStandardMaterialParameters = {}) => {
    const material = track(
      new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.7, ...extra })
    );
    accents.set(color, [...(accents.get(color) ?? []), material]);
    material.color.copy(accent(color));
    return material;
  };

  // Windows: a grid of panes, lit from inside at night.
  const windowTexture = (() => {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#000';
    context.fillRect(0, 0, 64, 64);
    context.fillStyle = '#fff';
    for (let row = 0; row < 4; row++) {
      for (let column = 0; column < 4; column++) {
        // A few dark panes: nobody is in every office.
        if ((row * 7 + column * 3) % 5 === 0) context.fillStyle = '#555';
        context.fillRect(column * 16 + 3, row * 16 + 4, 10, 8);
        context.fillStyle = '#fff';
      }
    }
    const texture = track(new THREE.CanvasTexture(canvas));
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.magFilter = THREE.NearestFilter;
    return texture;
  })();

  const lamp = (color: string) => {
    const material = track(
      new THREE.MeshStandardMaterial({ color: '#39424e', emissive: color, flatShading: true })
    );
    lamps.push(material);
    return material;
  };

  const mesh = (geometry: THREE.BufferGeometry, material: THREE.Material) => {
    const object = new THREE.Mesh(track(geometry), material);
    object.castShadow = true;
    object.receiveShadow = true;
    return object;
  };

  /** A box standing on the height y. */
  const box = (
    width: number,
    height: number,
    depth: number,
    material: THREE.Material,
    x = 0,
    y = 0,
    z = 0
  ) => {
    const object = mesh(new THREE.BoxGeometry(width, height, depth), material);
    object.position.set(x, y + height / 2, z);
    return object;
  };

  const cylinder = (
    radius: number,
    height: number,
    material: THREE.Material,
    x = 0,
    y = 0,
    z = 0,
    sides = 10
  ) => {
    const object = mesh(new THREE.CylinderGeometry(radius, radius, height, sides), material);
    object.position.set(x, y + height / 2, z);
    return object;
  };

  /** A triangular prism lying along z: a pitched roof, a pediment. */
  const prism = (width: number, height: number, depth: number, material: THREE.Material) => {
    const shape = new THREE.Shape();
    shape.moveTo(-width / 2, 0);
    shape.lineTo(width / 2, 0);
    shape.lineTo(0, height);
    shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
    geometry.translate(0, 0, -depth / 2);
    return mesh(geometry, material);
  };

  /** A glass tower in the colour of where the money is booked. */
  const tower = (color: WealthColor, width: number, height: number, x = 0, z = 0) => {
    const group = new THREE.Group();
    const texture = track(windowTexture.clone());
    texture.repeat.set(Math.max(1, Math.round(width * 2.5)) / 2, Math.round(height * 3) / 2);
    texture.needsUpdate = true;
    const glass = accentMaterial(color, {
      roughness: 0.35,
      metalness: 0.15,
      emissive: '#ffd58a',
      emissiveMap: texture,
      emissiveIntensity: 0,
    });
    lamps.push(glass);
    group.add(box(width, height, width, glass));
    group.add(box(width + 0.06, 0.06, width + 0.06, themedMaterial('stone'), 0, height));
    group.add(box(width + 0.1, 0.08, width + 0.1, themedMaterial('stone')));
    group.position.set(x, 0, z);
    return group;
  };

  const goldMaterial = () =>
    themedMaterial('gold', {
      roughness: 0.3,
      metalness: 0.35,
      emissive: '#8a5a00',
      emissiveIntensity: 0.45,
    });

  /** A chest with its lid thrown back: heaped with gold, or bare to the boards. */
  const chest = (full: boolean): Model => {
    const group = new THREE.Group();
    const wood = themedMaterial('brick');
    const iron = themedMaterial('iron');
    group.add(box(0.95, 0.42, 0.62, wood));
    for (const x of [-0.3, 0.3]) group.add(box(0.09, 0.44, 0.66, iron, x));
    const lid = box(0.95, 0.1, 0.62, wood);
    lid.position.set(0, 0.62, -0.42);
    lid.rotation.x = -1.05;
    group.add(lid);
    if (full) {
      const heap = mesh(new THREE.IcosahedronGeometry(0.36, 1), goldMaterial());
      heap.scale.set(1.15, 0.6, 0.72);
      heap.position.y = 0.42;
      group.add(heap);
    } else {
      group.add(box(0.85, 0.02, 0.52, iron, 0, 0.41));
    }
    return { group, height: full ? 0.95 : 0.85 };
  };

  const builders: Record<string, (color: WealthColor) => Model> = {
    surplus: () => chest(true),
    shortfall: () => chest(false),

    office: (color) => {
      const group = new THREE.Group();
      group.add(tower(color, 0.8, 0.95));
      group.add(box(0.36, 0.14, 0.36, themedMaterial('stone'), 0, 1.01));
      return { group, height: 1.25 };
    },

    taxes: () => {
      const group = new THREE.Group();
      const stone = themedMaterial('stone');
      group.add(box(1.2, 0.1, 0.9, stone));
      group.add(box(0.95, 0.5, 0.6, stone, 0, 0.1, -0.05));
      for (let i = 0; i < 4; i++) {
        group.add(cylinder(0.055, 0.5, stone, -0.42 + i * 0.28, 0.1, 0.33, 8));
      }
      group.add(box(1.1, 0.09, 0.82, stone, 0, 0.6));
      const dome = mesh(
        new THREE.SphereGeometry(0.3, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2),
        themedMaterial('roof')
      );
      dome.position.y = 0.69;
      group.add(dome);
      return { group, height: 1.15 };
    },

    real_estate: () => {
      const group = new THREE.Group();
      const wall = themedMaterial('wall');
      group.add(box(1.1, 0.62, 0.85, wall));
      const roof = prism(0.98, 0.5, 1.24, themedMaterial('roof'));
      roof.rotation.y = Math.PI / 2;
      roof.position.y = 0.62;
      group.add(roof);
      group.add(box(0.14, 0.42, 0.14, themedMaterial('brick'), 0.3, 0.72, -0.15));
      group.add(box(0.2, 0.34, 0.03, themedMaterial('roof'), 0, 0, 0.435));
      const pane = lamp('#ffd27a');
      group.add(box(0.2, 0.18, 0.03, pane, -0.34, 0.28, 0.435));
      group.add(box(0.2, 0.18, 0.03, pane, 0.34, 0.28, 0.435));
      group.add(box(0.03, 0.18, 0.2, pane, 0.56, 0.28, 0));
      return { group, height: 1.2 };
    },

    cash: () => {
      const group = new THREE.Group();
      const gold = goldMaterial();
      group.add(box(1.25, 0.08, 0.95, themedMaterial('iron')));
      const layers = [
        { count: 3, rows: 2 },
        { count: 2, rows: 2 },
        { count: 1, rows: 1 },
      ];
      layers.forEach(({ count, rows }, layer) => {
        for (let i = 0; i < count; i++) {
          for (let row = 0; row < rows; row++) {
            const ingot = mesh(new THREE.CylinderGeometry(0.105, 0.15, 0.15, 4), gold);
            // A four-sided cylinder, turned and stretched, is the trapezoid of an ingot.
            ingot.rotation.y = Math.PI / 4;
            ingot.scale.set(1.75, 1, 1);
            ingot.position.set(
              (i - (count - 1) / 2) * 0.39,
              0.08 + 0.075 + layer * 0.155,
              (row - (rows - 1) / 2) * 0.3
            );
            group.add(ingot);
          }
        }
      });
      return { group, height: 0.75 };
    },

    equities: (color) => {
      const group = new THREE.Group();
      group.add(tower(color, 0.62, 1.7));
      group.add(box(0.3, 0.2, 0.3, themedMaterial('stone'), 0, 1.76));
      group.add(cylinder(0.02, 0.5, themedMaterial('iron'), 0, 1.96, 0, 5));
      return { group, height: 2.5 };
    },

    funds: (color) => {
      const group = new THREE.Group();
      group.add(tower(color, 0.46, 1.45, -0.3, -0.18));
      group.add(tower(color, 0.44, 1.05, 0.3, -0.05));
      group.add(tower(color, 0.4, 0.7, -0.08, 0.38));
      return { group, height: 1.6 };
    },

    bonds: (color) => {
      const group = new THREE.Group();
      group.add(tower(color, 0.95, 0.6));
      const middle = tower(color, 0.68, 0.45);
      middle.position.y = 0.66;
      group.add(middle);
      const top = tower(color, 0.42, 0.35);
      top.position.y = 1.17;
      group.add(top);
      return { group, height: 1.65 };
    },

    structured_products: (color) => {
      const group = new THREE.Group();
      [0.8, 0.66, 0.52, 0.38].forEach((width, i) => {
        const part = tower(color, width, 0.42);
        part.position.y = i * 0.48;
        part.rotation.y = i * 0.35;
        group.add(part);
      });
      return { group, height: 2.05 };
    },

    business_stake: () => {
      const group = new THREE.Group();
      const brick = themedMaterial('brick');
      group.add(box(1.2, 0.5, 0.85, brick));
      for (let i = 0; i < 3; i++) {
        const tooth = prism(0.4, 0.22, 0.85, themedMaterial('stone'));
        tooth.position.set(-0.4 + i * 0.4, 0.5, 0);
        group.add(tooth);
      }
      group.add(cylinder(0.1, 1.15, brick, 0.42, 0, -0.2, 8));
      group.add(box(0.26, 0.3, 0.03, themedMaterial('iron'), -0.3, 0, 0.435));
      group.add(box(0.5, 0.14, 0.03, lamp('#ffd27a'), 0.25, 0.22, 0.435));
      const smoke = track(
        new THREE.MeshStandardMaterial({ color: '#f1f1f1', transparent: true, flatShading: true })
      );
      const puffs = [0, 1, 2, 3].map(() => {
        const puff = new THREE.Mesh(track(new THREE.IcosahedronGeometry(0.11, 0)), smoke);
        group.add(puff);
        return puff;
      });
      const tick = (time: number) => {
        puffs.forEach((puff, i) => {
          const age = (time * 0.35 + i / puffs.length) % 1;
          puff.position.set(0.42 + age * 0.35, 1.2 + age * 0.9, -0.2);
          puff.scale.setScalar(0.6 + age * 1.3);
          puff.visible = age < 0.92;
        });
      };
      tick(0);
      return { group, height: 1.9, tick };
    },

    art_collectibles: (color) => {
      const group = new THREE.Group();
      const stone = themedMaterial('stone');
      group.add(box(1.25, 0.1, 0.95, stone));
      group.add(box(1.0, 0.55, 0.55, stone, 0, 0.1, -0.1));
      for (let i = 0; i < 4; i++) {
        group.add(cylinder(0.055, 0.55, stone, -0.45 + i * 0.3, 0.1, 0.32, 8));
      }
      group.add(box(1.15, 0.08, 0.85, stone, 0, 0.65));
      const pediment = prism(1.15, 0.28, 0.85, stone);
      pediment.position.y = 0.73;
      group.add(pediment);
      // The painting inside, seen between the columns.
      group.add(box(0.3, 0.24, 0.02, accentMaterial(color), 0, 0.26, 0.19));
      return { group, height: 1.3 };
    },

    crypto: () => {
      const group = new THREE.Group();
      group.add(cylinder(0.42, 0.1, themedMaterial('iron'), 0, 0, 0, 8));
      const glow = track(
        new THREE.MeshStandardMaterial({
          color: '#7fe9ff',
          emissive: '#22c8ff',
          emissiveIntensity: 0.9,
          flatShading: true,
          roughness: 0.2,
        })
      );
      const gem = mesh(new THREE.OctahedronGeometry(0.36, 0), glow);
      gem.scale.y = 1.35;
      group.add(gem);
      const tick = (time: number) => {
        gem.rotation.y = time * 1.4;
        gem.position.y = 0.75 + Math.sin(time * 2.2) * 0.07;
        glow.emissiveIntensity = 0.75 + Math.sin(time * 6) * 0.2;
      };
      tick(0);
      return { group, height: 1.5, tick };
    },

    debt: () => {
      const group = new THREE.Group();
      const iron = themedMaterial('iron', { roughness: 0.5, metalness: 0.4 });
      const ball = mesh(new THREE.IcosahedronGeometry(0.42, 1), iron);
      ball.position.y = 0.42;
      group.add(ball);
      const ring = mesh(new THREE.TorusGeometry(0.1, 0.03, 6, 10), iron);
      ring.position.y = 0.9;
      group.add(ring);
      return { group, height: 1.1 };
    },

    other: (color) => {
      const group = new THREE.Group();
      group.add(box(0.8, 0.6, 0.8, themedMaterial('wall')));
      group.add(box(0.86, 0.1, 0.86, accentMaterial(color), 0, 0.25));
      return { group, height: 0.75 };
    },
  };

  const build = (item: IslandItem): Model => {
    if (item.kind === 'debt') return builders.debt(item.color);
    const flow = item.kind === 'income' || item.kind === 'expense';
    const key = flow ? (FLOW_MODEL[item.type] ?? 'other') : item.type;
    return (builders[key] ?? builders.other)(item.color);
  };

  /** The disc a building stands on, in its wealth colour. */
  const plinth = (color: WealthColor) => {
    const material = accentMaterial(color, { emissive: accent(color), emissiveIntensity: 0 });
    const disc = mesh(new THREE.CylinderGeometry(0.86, 0.9, 0.05, 24), material);
    disc.position.y = 0.025;
    disc.castShadow = false;
    return { disc, material };
  };

  const applyTheme = (palette: Palette) => {
    for (const { material, key } of themed.values()) material.color.set(palette[key]);
    for (const material of lamps) material.emissiveIntensity = palette.glow * 0.9;
    for (const [color, materials] of accents) {
      for (const material of materials) material.color.copy(accent(color));
    }
  };

  return {
    build,
    plinth,
    goldMaterial,
    themedMaterial,
    mesh,
    box,
    track,
    applyTheme,
    dispose: () => disposables.forEach((thing) => thing.dispose()),
  };
}

type Kit = ReturnType<typeof createKit>;

// --- the island itself ------------------------------------------------------------

function roundedRect(halfWidth: number, halfDepth: number, radius: number) {
  const shape = new THREE.Shape();
  shape.moveTo(-halfWidth + radius, -halfDepth);
  shape.lineTo(halfWidth - radius, -halfDepth);
  shape.quadraticCurveTo(halfWidth, -halfDepth, halfWidth, -halfDepth + radius);
  shape.lineTo(halfWidth, halfDepth - radius);
  shape.quadraticCurveTo(halfWidth, halfDepth, halfWidth - radius, halfDepth);
  shape.lineTo(-halfWidth + radius, halfDepth);
  shape.quadraticCurveTo(-halfWidth, halfDepth, -halfWidth, halfDepth - radius);
  shape.lineTo(-halfWidth, -halfDepth + radius);
  shape.quadraticCurveTo(-halfWidth, -halfDepth, -halfWidth + radius, -halfDepth);
  return shape;
}

/** A floating slab of land with a river that falls off its front edge. */
function buildIsland(kit: Kit, palette: () => Palette) {
  const group = new THREE.Group();
  const { halfWidth, halfDepth } = ISLAND;

  const slab = (scale: number, top: number, thickness: number, material: THREE.Material) => {
    const geometry = new THREE.ExtrudeGeometry(
      roundedRect(halfWidth * scale, halfDepth * scale, 1.1 * scale),
      { depth: thickness, bevelEnabled: false }
    );
    geometry.rotateX(Math.PI / 2);
    const object = kit.mesh(geometry, material);
    object.position.y = top;
    object.castShadow = false;
    return object;
  };

  group.add(slab(1, 0, 0.3, kit.themedMaterial('grass')));
  const earth = [0, 1, 2].map(() =>
    kit.track(new THREE.MeshStandardMaterial({ flatShading: true, roughness: 1 }))
  );
  group.add(slab(0.97, -0.3, 0.55, earth[0]));
  group.add(slab(0.82, -0.85, 0.6, earth[1]));
  group.add(slab(0.56, -1.45, 0.6, earth[2]));

  const water = kit.themedMaterial('water', {
    roughness: 0.25,
    transparent: true,
    opacity: 0.9,
    emissive: '#1b6fa8',
    emissiveIntensity: 0.15,
  });
  const river = kit.box(0.95, 0.03, halfDepth + 0.7, water, 0, 0, (halfDepth - 0.7) / 2 + 0.01);
  river.castShadow = false;
  group.add(river);
  const pond = kit.mesh(new THREE.CylinderGeometry(0.8, 0.8, 0.03, 20), water);
  pond.position.set(POND.x, 0.016, POND.z);
  pond.castShadow = false;
  group.add(pond);
  const fall = kit.box(0.95, 2.1, 0.06, water, 0, -2.08, halfDepth + 0.02);
  fall.castShadow = false;
  group.add(fall);

  // Foam running down the fall.
  const foam = kit.track(
    new THREE.MeshStandardMaterial({ color: '#ffffff', transparent: true, opacity: 0.8 })
  );
  const drops = Array.from({ length: 7 }, (_, i) => {
    const drop = new THREE.Mesh(kit.track(new THREE.BoxGeometry(0.09, 0.3, 0.03)), foam);
    drop.position.set(-0.36 + ((i * 5) % 7) * 0.12, 0, halfDepth + 0.06);
    group.add(drop);
    return drop;
  });

  // Banks of the river, so the two shores read as two.
  const edge = kit.themedMaterial('grassEdge');
  for (const side of [-1, 1]) {
    const bank = kit.box(0.14, 0.05, halfDepth, edge, side * 0.55, 0, halfDepth / 2);
    bank.castShadow = false;
    group.add(bank);
  }

  const cloudMaterial = kit.themedMaterial('cloud', { transparent: true, opacity: 0.92 });
  const clouds = [
    { x: -5, y: 3.4, z: -3.2, speed: 0.16 },
    { x: 3, y: 4.1, z: -1.5, speed: 0.11 },
  ].map((spec) => {
    const cloud = new THREE.Group();
    [
      [0, 0, 0, 0.5],
      [0.5, 0.05, 0.1, 0.38],
      [-0.48, -0.02, -0.05, 0.34],
      [0.1, 0.22, 0, 0.32],
    ].forEach(([x, y, z, radius]) => {
      const puff = new THREE.Mesh(
        kit.track(new THREE.IcosahedronGeometry(radius, 0)),
        cloudMaterial
      );
      puff.position.set(x, y, z);
      cloud.add(puff);
    });
    cloud.position.set(spec.x, spec.y, spec.z);
    group.add(cloud);
    return { cloud, ...spec };
  });

  const tick = (time: number) => {
    drops.forEach((drop, i) => {
      const age = (time * 0.7 + i * 0.37) % 1;
      drop.position.y = -0.1 - age * 1.9;
    });
    for (const { cloud, x, speed } of clouds) {
      cloud.position.x = ((x + time * speed + 8) % 16) - 8;
    }
  };

  const applyTheme = () => {
    earth.forEach((material, i) => material.color.set(palette().earth[i]));
  };

  return { group, tick, applyTheme };
}

// --- layout -----------------------------------------------------------------------

interface Placement {
  x: number;
  z: number;
  scale: number;
}

/**
 * Where everything stands and how big. A building's volume follows its value, so its size
 * follows the cube root; a zone with many items shrinks them all rather than overlap.
 */
function arrange(items: IslandItem[]): Map<string, Placement> {
  const placements = new Map<string, Placement>();
  const largest = Math.max(1, ...items.map((item) => item.value ?? 0));
  const size = (item: IslandItem) =>
    item.value === null || item.value <= 0
      ? UNKNOWN_SCALE
      : Math.min(1, Math.max(0.36, Math.cbrt(item.value / largest))) * 1.3;

  const ids = new Set(items.map((item) => item.id));
  const chained = (item: IslandItem) =>
    item.kind === 'debt' && !!item.securedBy && ids.has(item.securedBy);

  for (const zone of ['land', 'bank', 'other'] as const) {
    const area = ZONES[zone];
    const standing = items
      .filter((item) => item.zone === zone && !chained(item))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    if (standing.length === 0) continue;
    const width = area.x1 - area.x0;
    const depth = area.z1 - area.z0;
    let columns = Math.max(1, Math.ceil(Math.sqrt((standing.length * width) / depth)));
    columns = Math.min(columns, standing.length);
    const rows = Math.ceil(standing.length / columns);
    const cellWidth = width / columns;
    const cellDepth = depth / rows;
    const shrink = Math.min(1, Math.min(cellWidth, cellDepth) / CELL);
    standing.forEach((item, index) => {
      const row = Math.floor(index / columns);
      const inRow = Math.min(columns, standing.length - row * columns);
      const column = index % columns;
      // The largest stand at the back, so they do not hide the small ones.
      placements.set(item.id, {
        x: area.x0 + (width / inRow) * (column + 0.5),
        z: area.z0 + cellDepth * (row + 0.5),
        scale: size(item) * shrink,
      });
    });
  }

  // What the year leaves over stands in the pond, where every coin passes.
  const store = items.find((item) => item.kind === 'store');
  if (store) placements.set(store.id, { ...POND, scale: Math.min(size(store), 0.9) });

  // A secured debt sits at the foot of what secures it, on the side facing the viewer.
  const taken = new Map<string, number>();
  for (const item of items.filter(chained)) {
    const host = placements.get(item.securedBy!);
    if (!host) continue;
    const nth = taken.get(item.securedBy!) ?? 0;
    taken.set(item.securedBy!, nth + 1);
    const scale = size(item) * (host.scale / size(items.find((i) => i.id === item.securedBy)!));
    placements.set(item.id, {
      x: host.x + 0.8 * host.scale + 0.3 * scale - nth * 0.9 * scale,
      z: host.z + 0.85 * host.scale + 0.3 * scale,
      scale,
    });
  }
  return placements;
}

// --- the scene --------------------------------------------------------------------

interface Entry {
  item: IslandItem;
  group: THREE.Group;
  body: THREE.Group;
  plinth: THREE.MeshStandardMaterial | null;
  model: Model;
  /** Spring towards the scale the value asks for: a change of value grows or shrinks with a bounce. */
  scale: number;
  target: number;
  velocity: number;
  /** Seconds before it drops in. */
  delay: number;
  lift: number;
  label: HTMLDivElement;
  ghost: boolean;
}

interface Lit {
  hoverId: string | null;
  focus: Set<string>;
}

function createIsland(
  host: HTMLDivElement,
  labels: HTMLDivElement,
  zoneLabels: Record<IslandZone, HTMLElement | null>,
  onHover: (id: string | null) => void
) {
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isNight = () => document.documentElement.classList.contains('dark');
  const palette = (): Palette => (isNight() ? PALETTE.night : PALETTE.day);

  const css = (name: string) => getComputedStyle(host).getPropertyValue(name).trim();
  const accent = (color: WealthColor) =>
    new THREE.Color(css(WEALTH_COLOR[color].slice(4, -1)) || '#888888');

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  const hemisphere = new THREE.HemisphereLight();
  scene.add(hemisphere);
  const sun = new THREE.DirectionalLight('#fff4dc');
  sun.position.set(7, 12, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1536, 1536);
  sun.shadow.camera.left = -9;
  sun.shadow.camera.right = 9;
  sun.shadow.camera.top = 8;
  sun.shadow.camera.bottom = -8;
  sun.shadow.bias = -0.0015;
  scene.add(sun);

  const kit = createKit(accent);
  const island = buildIsland(kit, palette);
  scene.add(island.group);
  const chains = new THREE.Group();
  scene.add(chains);
  const chainMaterial = kit.themedMaterial('iron', { roughness: 0.5, metalness: 0.4 });
  const ghostMaterial = kit.track(
    new THREE.MeshStandardMaterial({
      color: '#9aa3ad',
      transparent: true,
      opacity: 0.38,
      flatShading: true,
      depthWrite: false,
    })
  );

  const applyTheme = () => {
    const colors = palette();
    kit.applyTheme(colors);
    island.applyTheme();
    hemisphere.color.set(colors.sky);
    hemisphere.groundColor.set(colors.ground);
    hemisphere.intensity = colors.ambient;
    sun.intensity = colors.sun;
    sun.color.set(isNight() ? '#b8c8ff' : '#fff4dc');
    for (const entry of entries.values()) {
      entry.plinth?.emissive.copy(accent(entry.item.color));
    }
  };

  const entries = new Map<string, Entry>();
  let lit: Lit = { hoverId: null, focus: new Set() };
  const started = performance.now() / 1000;

  // --- camera: a slow sway, a drag to turn, a flight to what Warren talks about ---
  const HOME = { azimuth: 0.42, polar: 1.04 };
  const CENTER = new THREE.Vector3(0, 0.1, 0.2);
  const view = { azimuth: HOME.azimuth, polar: HOME.polar, radius: 20, drag: 0 };
  const target = CENTER.clone();
  const lookAt = target.clone();
  let fitRadius = 20;
  let zoom = 1;

  const resize = () => {
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (width === 0 || height === 0) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    // A narrow stage steps back so the island still fits across.
    fitRadius = Math.max(19.5, 27 / Math.max(camera.aspect, 0.6));
    camera.updateProjectionMatrix();
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(host);
  resize();

  // --- items ---
  const makeGhost = (group: THREE.Group) =>
    group.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.material = ghostMaterial;
        object.castShadow = false;
      }
    });

  const addEntry = (item: IslandItem, placement: Placement, order: number): Entry => {
    const model = kit.build(item);
    const ghost = item.value === null || item.value <= 0;
    const group = new THREE.Group();
    const body = new THREE.Group();
    body.add(model.group);
    let plinthMaterial: THREE.MeshStandardMaterial | null = null;
    if (item.kind !== 'debt') {
      const { disc, material } = kit.plinth(item.color);
      plinthMaterial = material;
      body.add(disc);
      model.group.position.y = 0.05;
    }
    if (ghost) makeGhost(model.group);
    group.add(body);
    group.position.set(placement.x, 0, placement.z);
    group.traverse((object) => (object.userData.itemId = item.id));
    body.scale.setScalar(still ? placement.scale : 0.0001);
    scene.add(group);

    const label = document.createElement('div');
    label.className = 'isl-label';
    labels.appendChild(label);

    return {
      item,
      group,
      body,
      plinth: plinthMaterial,
      model,
      scale: still ? placement.scale : 0,
      target: placement.scale,
      velocity: 0,
      delay: still ? 0 : 0.25 + order * 0.09,
      lift: 0,
      label,
      ghost,
    };
  };

  const removeEntry = (entry: Entry) => {
    scene.remove(entry.group);
    entry.label.remove();
  };

  const writeLabel = (entry: Entry) => {
    const { item } = entry;
    const amount =
      item.value === null ? '?' : formatCompact(item.kind === 'debt' ? -item.value : item.value);
    entry.label.replaceChildren();
    const name = document.createElement('span');
    name.className = 'isl-label-name';
    name.textContent = item.label;
    const value = document.createElement('span');
    value.className = 'isl-label-value';
    value.textContent = amount;
    entry.label.append(name, value);
    entry.label.style.setProperty('--c', WEALTH_COLOR[item.color]);
    entry.label.dataset.unknown = String(item.value === null);
    entry.label.dataset.named = String(item.kind === 'store');
  };

  /** Links of iron from each secured debt to what secures it. */
  const rebuildChains = () => {
    chains.clear();
    for (const entry of entries.values()) {
      const hostEntry = entry.item.securedBy ? entries.get(entry.item.securedBy) : undefined;
      if (entry.item.kind !== 'debt' || !hostEntry) continue;
      const from = entry.group.position.clone().setY(0.9 * entry.target);
      const to = hostEntry.group.position
        .clone()
        .add(
          new THREE.Vector3(0.56 * hostEntry.target, 0.3 * hostEntry.target, 0.3 * hostEntry.target)
        );
      const span = from.distanceTo(to);
      const count = Math.max(4, Math.ceil(span / 0.13));
      const chain = new THREE.Group();
      chain.userData.ends = [entry, hostEntry];
      const direction = to.clone().sub(from).normalize();
      for (let i = 0; i <= count; i++) {
        const t = i / count;
        const link = kit.mesh(new THREE.TorusGeometry(0.075, 0.026, 5, 8), chainMaterial);
        link.position.lerpVectors(from, to, t);
        link.position.y = Math.max(0.06, link.position.y - Math.sin(Math.PI * t) * 0.2 * span);
        link.lookAt(link.position.clone().add(direction));
        link.rotateY(Math.PI / 2);
        if (i % 2) link.rotateX(Math.PI / 2);
        link.userData.itemId = entry.item.id;
        chain.add(link);
      }
      chains.add(chain);
    }
  };

  // --- coins: income flies to the pond, expenses fly out of it ---
  const coinGeometry = kit.track(new THREE.CylinderGeometry(0.085, 0.085, 0.03, 10));
  const coins = Array.from({ length: COINS }, () => {
    const coin = new THREE.Mesh(coinGeometry, kit.goldMaterial());
    coin.castShadow = true;
    coin.visible = false;
    scene.add(coin);
    return coin;
  });
  let streams: { entry: Entry; out: boolean; coins: THREE.Mesh[] }[] = [];
  const hub = new THREE.Vector3();
  const tip = new THREE.Vector3();

  /** The more a flow carries, the more of the coins are its own. */
  const rebuildStreams = () => {
    for (const coin of coins) coin.visible = false;
    const flowing = [...entries.values()].filter(
      ({ item, ghost }) => (item.kind === 'income' || item.kind === 'expense') && !ghost
    );
    const total = flowing.reduce((sum, entry) => sum + (entry.item.value ?? 0), 0);
    let next = 0;
    streams = flowing.map((entry) => {
      const share = ((entry.item.value ?? 0) / total) * (COINS - flowing.length);
      const mine = coins.slice(next, next + 1 + Math.floor(share));
      next += mine.length;
      return { entry, out: entry.item.kind === 'expense', coins: mine };
    });
  };

  const moveCoins = (time: number) => {
    const store = [...entries.values()].find((entry) => entry.item.kind === 'store');
    hub.set(POND.x, store ? 0.55 * store.scale + 0.15 : 0.15, POND.z);
    streams.forEach(({ entry, out, coins: mine }, index) => {
      const grown = entry.scale > entry.target * 0.9;
      tip.copy(entry.group.position).setY(entry.model.height * entry.scale * 0.7);
      mine.forEach((coin, i) => {
        // Standing still, the coins hang in their arc.
        const t = still
          ? (i + 0.5) / mine.length
          : (time * 0.26 + i / mine.length + index * 0.13) % 1;
        coin.visible = grown;
        coin.position.lerpVectors(out ? hub : tip, out ? tip : hub, t);
        coin.position.y += Math.sin(Math.PI * t) * 1.5;
        coin.rotation.set(time * 4 + i, time * 2.2 + i * 2, 0);
        coin.scale.setScalar(Math.min(1, t * 7, (1 - t) * 7));
      });
    });
  };

  const sync = (items: IslandItem[], changed: Set<string>) => {
    const placements = arrange(items);
    const seen = new Set<string>();
    let order = 0;
    for (const item of items) {
      const placement = placements.get(item.id);
      if (!placement) continue;
      seen.add(item.id);
      let entry = entries.get(item.id);
      const ghost = item.value === null || item.value <= 0;
      // A different thing, or one whose value just became known, is built anew.
      if (entry && (entry.item.type !== item.type || entry.ghost !== ghost)) {
        removeEntry(entry);
        entries.delete(item.id);
        entry = undefined;
      }
      if (!entry) {
        entry = addEntry(item, placement, order++);
        entries.set(item.id, entry);
      } else {
        entry.item = item;
        entry.target = placement.scale;
        entry.group.position.set(placement.x, 0, placement.z);
        // A kick, so that what changed is seen to change.
        if (changed.has(item.id) && !still) entry.velocity += 3.2;
      }
      writeLabel(entry);
    }
    for (const [id, entry] of entries) {
      if (seen.has(id)) continue;
      removeEntry(entry);
      entries.delete(id);
    }
    rebuildChains();
    rebuildStreams();
    applyTheme();
  };

  // --- pointer: hover lights an item, a drag turns the island ---
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let pointerInside = false;
  let pointerMoved = false;
  let dragging: { x: number; y: number; azimuth: number; polar: number } | null = null;
  let hovered: string | null = null;

  const setPointer = (event: PointerEvent) => {
    const rect = host.getBoundingClientRect();
    pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
  };
  const onPointerMove = (event: PointerEvent) => {
    setPointer(event);
    pointerInside = true;
    pointerMoved = true;
    if (dragging) {
      const dx = event.clientX - dragging.x;
      const dy = event.clientY - dragging.y;
      view.drag = Math.max(-1.1, Math.min(1.1, dragging.azimuth - dx * 0.006));
      view.polar = Math.max(0.6, Math.min(1.25, dragging.polar - dy * 0.004));
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
  const onWheel = (event: WheelEvent) => {
    // Only a pinch or ctrl+wheel zooms: a plain wheel keeps scrolling the page.
    if (!event.ctrlKey) return;
    event.preventDefault();
    zoom = Math.max(0.55, Math.min(1.15, zoom * (1 + event.deltaY * 0.004)));
  };
  host.addEventListener('pointermove', onPointerMove);
  host.addEventListener('pointerdown', onPointerDown);
  host.addEventListener('pointerup', onPointerUp);
  host.addEventListener('pointercancel', onPointerUp);
  host.addEventListener('pointerleave', onPointerLeave);
  host.addEventListener('wheel', onWheel, { passive: false });

  const pick = () => {
    if (!pointerInside || dragging) return;
    raycaster.setFromCamera(pointer, camera);
    const targets = [...entries.values()].map((entry) => entry.group as THREE.Object3D);
    const hit = raycaster.intersectObjects([...targets, chains], true)[0];
    const id = (hit?.object.userData.itemId as string | undefined) ?? null;
    if (id !== hovered) {
      hovered = id;
      onHover(id);
    }
    host.style.cursor = id ? 'pointer' : '';
  };

  // --- the frame ---
  const projected = new THREE.Vector3();
  const place = (element: HTMLElement, x: number, y: number, z: number, lift = '-100%') => {
    projected.set(x, y, z).project(camera);
    const visible = projected.z < 1;
    element.style.transform = `translate(-50%, ${lift}) translate(${((projected.x + 1) / 2) * host.clientWidth}px, ${((1 - projected.y) / 2) * host.clientHeight}px)`;
    element.style.visibility = visible ? 'visible' : 'hidden';
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
    const time = now - started;

    // What is lit: under the pointer, or what Warren is talking about.
    const isLit = (id: string) => id === lit.hoverId || lit.focus.has(id);
    const anyLit = [...entries.keys()].some(isLit);
    const focused = [...entries.values()].filter((entry) => lit.focus.has(entry.item.id));

    // The camera flies to what is in focus, and home again.
    if (focused.length > 0) {
      target.set(0, 0, 0);
      for (const entry of focused) target.add(entry.group.position);
      target.multiplyScalar(0.7 / focused.length).setY(0.5);
    } else {
      target.copy(CENTER);
    }
    const ease = still ? 1 : 1 - Math.exp(-dt * 3);
    lookAt.lerp(target, ease);
    const radius = fitRadius * zoom * (focused.length > 0 ? 0.74 : 1);
    view.radius += (radius - view.radius) * ease;
    const sway = still || dragging || anyLit ? 0 : Math.sin(time * 0.25) * 0.06;
    view.azimuth +=
      (HOME.azimuth + view.drag + sway - view.azimuth) * (still ? 1 : 1 - Math.exp(-dt * 6));
    camera.position.set(
      lookAt.x + view.radius * Math.sin(view.polar) * Math.sin(view.azimuth),
      lookAt.y + view.radius * Math.cos(view.polar),
      lookAt.z + view.radius * Math.sin(view.polar) * Math.cos(view.azimuth)
    );
    camera.lookAt(lookAt);
    camera.updateMatrixWorld();

    island.tick(time);
    for (const entry of entries.values()) {
      const on = isLit(entry.item.id);
      if (time >= entry.delay) {
        if (still) {
          entry.scale = entry.target;
        } else {
          entry.velocity += ((entry.target - entry.scale) * 140 - entry.velocity * 11) * dt;
          entry.scale = Math.max(0.0001, entry.scale + entry.velocity * dt);
        }
      }
      entry.lift += ((on ? 1 : 0) - entry.lift) * (still ? 1 : 1 - Math.exp(-dt * 12));
      const pulse = lit.focus.has(entry.item.id) && !still ? 1 + Math.sin(time * 4.5) * 0.035 : 1;
      entry.body.scale.setScalar(entry.scale * (1 + entry.lift * 0.08) * pulse);
      // What is not known hovers like a mirage.
      entry.body.position.y =
        entry.lift * 0.16 + (entry.ghost && !still ? 0.08 + Math.sin(time * 1.6) * 0.05 : 0);
      if (entry.plinth) entry.plinth.emissiveIntensity = entry.lift * 0.75;
      entry.model.tick?.(time);

      const top = (entry.model.height + 0.28) * entry.scale + entry.body.position.y;
      place(entry.label, entry.group.position.x, top, entry.group.position.z);
      entry.label.dataset.lit = String(on);
      entry.label.dataset.dim = String(anyLit && !on);
      entry.label.style.opacity = entry.scale > entry.target * 0.5 ? '' : '0';
    }
    moveCoins(time);
    for (const chain of chains.children) {
      const [a, b] = chain.userData.ends as Entry[];
      chain.visible = a.scale > a.target * 0.9 && b.scale > b.target * 0.9;
    }
    for (const zone of ['bank', 'other', 'land'] as const) {
      const element = zoneLabels[zone];
      if (element) place(element, ...ZONE_ANCHOR[zone], '-50%');
    }

    if (pointerMoved) {
      pointerMoved = false;
      pick();
    }
    renderer.render(scene, camera);
  };
  frame = requestAnimationFrame(render);

  // The theme is a class on <html>: repaint when it flips.
  const themeObserver = new MutationObserver(applyTheme);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

  return {
    sync,
    setLit: (next: Lit) => (lit = next),
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
      host.removeEventListener('wheel', onWheel);
      for (const entry of entries.values()) entry.label.remove();
      kit.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

/**
 * Wealth as an island: every item is a building of its kind whose volume follows its value.
 * For the balance sheet the river parts what is at the house bank from what is elsewhere, and
 * a secured debt is an iron ball chained to what secures it. For income and expenses the
 * river parts the two, and coins fly from the one to the other through the pond.
 */
export function Island3D({
  items,
  zones,
  currency,
  description,
  changed,
  focus,
  hoverId,
  onHover,
}: Island3DProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const zoneRefs = useRef<Record<IslandZone, HTMLElement | null>>({
    bank: null,
    other: null,
    land: null,
  });
  const islandRef = useRef<ReturnType<typeof createIsland> | null>(null);
  const onHoverRef = useRef(onHover);
  onHoverRef.current = onHover;

  useEffect(() => {
    if (!hostRef.current || !labelsRef.current) return;
    const island = createIsland(hostRef.current, labelsRef.current, zoneRefs.current, (id) =>
      onHoverRef.current(id)
    );
    islandRef.current = island;
    return () => {
      islandRef.current = null;
      island.dispose();
    };
  }, []);

  // Rebuilt only when what is on the island changes, not on every hover.
  const signature = JSON.stringify(items);
  useEffect(() => {
    islandRef.current?.sync(items, changed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  useEffect(() => {
    islandRef.current?.setLit({ hoverId, focus });
  }, [hoverId, focus]);

  const active = items.find((item) => item.id === hoverId) ?? null;
  const used = new Set(items.map((item) => item.zone));

  return (
    <div className="isl-stage" role="img" aria-label={description}>
      <div ref={hostRef} className="isl-canvas" />
      <div className="isl-overlay" aria-hidden>
        {(['bank', 'other', 'land'] as const).map((zone) => (
          <div
            key={zone}
            ref={(element) => {
              zoneRefs.current[zone] = element;
            }}
            className="isl-zone"
            data-empty={!used.has(zone)}
            hidden={!zones[zone]}
          >
            {zones[zone]}
          </div>
        ))}
        <div ref={labelsRef} />
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
                : `${currency} ${formatNumber(active.value)}`}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
