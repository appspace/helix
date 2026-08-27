/**
 * Force-directed placement for the foreign-key diagram.
 *
 * Fruchterman–Reingold: every pair of tables repels, every foreign key pulls
 * its two tables together, and a weak pull toward the centre keeps components
 * that share no keys from drifting apart. A final pass separates any boxes that
 * still overlap, because a readable diagram matters more than force purity.
 *
 * Deliberately deterministic — seeding is a fixed spiral rather than random —
 * so reopening the diagram for the same schema gives the same picture, and the
 * tests can assert on real coordinates.
 */

export interface ErdLayoutBox {
  table: string;
  width: number;
  height: number;
}

export interface ErdLayoutEdge {
  from: string;
  to: string;
}

export interface ErdLayoutNode extends ErdLayoutBox {
  /** Top-left corner, normalised so the whole diagram starts at `MARGIN`. */
  x: number;
  y: number;
}

export interface ErdLayout {
  nodes: ErdLayoutNode[];
  /** Bounding size of the laid-out diagram, margins included. */
  width: number;
  height: number;
}

const MARGIN = 40;
/** Empty gutter kept between two boxes by the separation pass. */
const GAP = 28;
const ITERATIONS = 400;
/**
 * Repulsion is ignored past this many ideal distances. Without a cutoff, a
 * table that shares no foreign keys feels the whole schema pushing it away and
 * ends up parked in its own postcode, which zooms the whole diagram out.
 */
const REPULSION_RANGE = 2;
/** Pull toward the origin, proportional to distance. Balances repulsion into a finite radius. */
const GRAVITY = 0.8;
/** Golden angle: successive seeds land on a spiral that never repeats a spoke. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Ideal edge length — roughly one box apart, so linked tables sit adjacent but not touching. */
function idealDistance(boxes: ErdLayoutBox[]): number {
  const avg = boxes.reduce((sum, b) => sum + (b.width + b.height) / 2, 0) / boxes.length;
  return Math.max(avg * 1.2, 120);
}

export function layoutErd(boxes: ErdLayoutBox[], edges: ErdLayoutEdge[]): ErdLayout {
  if (boxes.length === 0) return { nodes: [], width: 0, height: 0 };

  if (boxes.length === 1) {
    const only = boxes[0];
    return {
      nodes: [{ ...only, x: MARGIN, y: MARGIN }],
      width: only.width + MARGIN * 2,
      height: only.height + MARGIN * 2,
    };
  }

  const k = idealDistance(boxes);
  const index = new Map(boxes.map((b, i) => [b.table, i]));

  // Seed on a spiral: spreading the first placement out this way gives the
  // simulation something to relax rather than an overlapped pile to escape.
  const px = new Float64Array(boxes.length);
  const py = new Float64Array(boxes.length);
  for (let i = 0; i < boxes.length; i++) {
    const radius = k * Math.sqrt(i + 0.5);
    px[i] = radius * Math.cos(i * GOLDEN_ANGLE);
    py[i] = radius * Math.sin(i * GOLDEN_ANGLE);
  }

  // Self-references pull a table toward itself — no force, drawn as a loop instead.
  const links = edges
    .map(e => ({ a: index.get(e.from), b: index.get(e.to) }))
    .filter((l): l is { a: number; b: number } => l.a !== undefined && l.b !== undefined && l.a !== l.b);

  const dx = new Float64Array(boxes.length);
  const dy = new Float64Array(boxes.length);

  for (let step = 0; step < ITERATIONS; step++) {
    // Linear cooling: large rearrangements early, fine adjustment late.
    const temperature = k * 0.8 * (1 - step / ITERATIONS);
    dx.fill(0);
    dy.fill(0);

    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        let vx = px[i] - px[j];
        let vy = py[i] - py[j];
        let dist = Math.hypot(vx, vy);
        if (dist > k * REPULSION_RANGE) continue;
        if (dist < 0.01) {
          // Coincident nodes have no direction to push along; nudge them apart
          // on a per-pair diagonal so the next iteration has something to work with.
          vx = (i - j) * 0.01;
          vy = 0.01;
          dist = Math.hypot(vx, vy);
        }
        const force = (k * k) / dist;
        const ux = (vx / dist) * force;
        const uy = (vy / dist) * force;
        dx[i] += ux; dy[i] += uy;
        dx[j] -= ux; dy[j] -= uy;
      }
    }

    for (const { a, b } of links) {
      const vx = px[a] - px[b];
      const vy = py[a] - py[b];
      const dist = Math.max(Math.hypot(vx, vy), 0.01);
      const force = (dist * dist) / k;
      const ux = (vx / dist) * force;
      const uy = (vy / dist) * force;
      dx[a] -= ux; dy[a] -= uy;
      dx[b] += ux; dy[b] += uy;
    }

    for (let i = 0; i < boxes.length; i++) {
      // Gravity toward the origin. Without it, tables sharing no foreign key
      // repel forever and the diagram opens zoomed out to nothing.
      dx[i] -= px[i] * GRAVITY;
      dy[i] -= py[i] * GRAVITY;

      const disp = Math.hypot(dx[i], dy[i]);
      if (disp < 1e-9) continue;
      const capped = Math.min(disp, temperature) / disp;
      px[i] += dx[i] * capped;
      py[i] += dy[i] * capped;
    }
  }

  const nodes: ErdLayoutNode[] = boxes.map((b, i) => ({
    ...b,
    x: px[i] - b.width / 2,
    y: py[i] - b.height / 2,
  }));

  separate(nodes);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width); maxY = Math.max(maxY, n.y + n.height);
  }
  for (const n of nodes) {
    n.x = n.x - minX + MARGIN;
    n.y = n.y - minY + MARGIN;
  }

  return {
    nodes,
    width: maxX - minX + MARGIN * 2,
    height: maxY - minY + MARGIN * 2,
  };
}

/**
 * Push overlapping boxes apart along whichever axis they overlap least, which
 * keeps the force layout's arrangement while making every box readable.
 * Mutates `nodes` in place.
 */
function separate(nodes: ErdLayoutNode[]): void {
  for (let pass = 0; pass < 60; pass++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const overlapX = Math.min(a.x + a.width + GAP, b.x + b.width + GAP) - Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + a.height + GAP, b.y + b.height + GAP) - Math.max(a.y, b.y);
        if (overlapX <= 0 || overlapY <= 0) continue;

        moved = true;
        if (overlapX < overlapY) {
          const shift = overlapX / 2;
          if (a.x <= b.x) { a.x -= shift; b.x += shift; } else { a.x += shift; b.x -= shift; }
        } else {
          const shift = overlapY / 2;
          if (a.y <= b.y) { a.y -= shift; b.y += shift; } else { a.y += shift; b.y -= shift; }
        }
      }
    }
    if (!moved) break;
  }
}

/**
 * Where the segment from `from`'s centre to `to`'s centre leaves the `from`
 * box. Edges are drawn between these points so an arrow lands on a border
 * rather than disappearing under a box.
 */
export function borderPoint(from: ErdLayoutNode, to: ErdLayoutNode): { x: number; y: number } {
  const cx = from.x + from.width / 2;
  const cy = from.y + from.height / 2;
  const tx = to.x + to.width / 2;
  const ty = to.y + to.height / 2;
  const vx = tx - cx;
  const vy = ty - cy;
  if (vx === 0 && vy === 0) return { x: cx, y: cy };

  const halfW = from.width / 2;
  const halfH = from.height / 2;
  // Scale the direction vector until it hits whichever edge it reaches first.
  const scaleX = vx === 0 ? Infinity : halfW / Math.abs(vx);
  const scaleY = vy === 0 ? Infinity : halfH / Math.abs(vy);
  const scale = Math.min(scaleX, scaleY);
  return { x: cx + vx * scale, y: cy + vy * scale };
}
