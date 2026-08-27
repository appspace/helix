/**
 * Radial placement for the foreign-key diagram.
 *
 * The diagram has a centre — the focus table, or the most-connected one — and
 * everything else radiates outward from it in rings, one ring per hop. A ring
 * that can't hold its tables spills into another row further out rather than
 * inflating, so a hub with sixty dependants becomes a few tight rows around it
 * instead of one enormous circle. Within a ring, tables are ordered by their
 * parent's angle, which keeps each cluster of dependants together.
 *
 * The earlier version seeded on a spiral, relaxed with a force simulation, and
 * separated overlaps along whichever axis two boxes overlapped least. Table
 * boxes are far wider than they are tall, so that axis was nearly always the
 * vertical one: a crowded schema collapsed under gravity and then unfolded into
 * a tall column with a spike on top. Both the rings and the centre-line
 * separation below exist to remove any preferred axis.
 *
 * Deliberately deterministic — no randomness anywhere — so reopening the
 * diagram for the same schema gives the same picture, and the tests can assert
 * on real coordinates.
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
  /** Table the diagram is built around; '' when there are no tables. */
  centre: string;
}

export interface ErdLayoutOptions {
  /**
   * Table to put in the middle. Ignored when it isn't in `boxes`; without it
   * the most-connected table wins.
   */
  centre?: string | null;
}

const MARGIN = 40;
/** Empty gutter kept between two boxes. */
const GAP = 28;
/** Extra breathing room between a parent's ring of children and the next one out. */
const RING_PADDING = 18;

/** Radius of the circle that encloses a box — what the packing works in. */
function boxRadius(box: ErdLayoutBox): number {
  return Math.hypot(box.width, box.height) / 2;
}

interface Graph {
  /** Neighbour indices, both directions, no duplicates, no self-loops. */
  adjacency: number[][];
  hub: number;
}

function buildGraph(boxes: ErdLayoutBox[], edges: ErdLayoutEdge[], preferredCentre?: string | null): Graph {
  const index = new Map(boxes.map((b, i) => [b.table, i]));
  const adjacency: number[][] = boxes.map(() => []);
  for (const edge of edges) {
    const a = index.get(edge.from);
    const b = index.get(edge.to);
    // Self-references and edges leaving the diagram carry no position
    // information — they're drawn (as a loop, or not at all) but never pull.
    if (a === undefined || b === undefined || a === b) continue;
    if (!adjacency[a].includes(b)) adjacency[a].push(b);
    if (!adjacency[b].includes(a)) adjacency[b].push(a);
  }

  const preferred = preferredCentre ? index.get(preferredCentre) : undefined;
  if (preferred !== undefined) return { adjacency, hub: preferred };

  // Most relationships wins; ties go to the earliest in input order, which the
  // callers sort by name, so the choice is stable.
  let hub = 0;
  for (let i = 1; i < boxes.length; i++) {
    if (adjacency[i].length > adjacency[hub].length) hub = i;
  }
  return { adjacency, hub };
}

/** A table's ring (hops from the hub) and which table it hangs off. */
interface Placement {
  level: number[];
  parent: number[];
  /** Deepest ring reachable from the hub; anything beyond is an unconnected table. */
  mainDepth: number;
}

/**
 * Breadth-first rings around the hub. Tables the hub can't reach — separate
 * components, and tables with no foreign keys at all — are pushed to the ring
 * past the main graph so they spread around the rim instead of piling into a
 * corner.
 */
function assignRings(adjacency: number[][], hub: number): Placement {
  const n = adjacency.length;
  const level = new Array<number>(n).fill(-1);
  const parent = new Array<number>(n).fill(-1);
  level[hub] = 0;

  const walk = (queue: number[]) => {
    for (let head = 0; head < queue.length; head++) {
      const v = queue[head];
      for (const w of adjacency[v]) {
        if (level[w] !== -1) continue;
        level[w] = level[v] + 1;
        parent[w] = v;
        queue.push(w);
      }
    }
  };
  walk([hub]);

  const mainDepth = Math.max(...level);
  const stragglers: number[] = [];  // separate components and tables with no keys at all
  for (let i = 0; i < n; i++) if (level[i] === -1) stragglers.push(i);
  // Biggest leftover components first, so the heaviest claim their arc before
  // the loose tables.
  stragglers.sort((a, b) => adjacency[b].length - adjacency[a].length || a - b);
  for (const root of stragglers) {
    if (level[root] !== -1) continue;
    level[root] = mainDepth + 1;
    parent[root] = hub;
    walk([root]);
  }

  return { level, parent, mainDepth };
}

/** Distance from the centre to a box's far corner. */
function reachOf(box: ErdLayoutBox, x: number, y: number): number {
  return Math.hypot(x, y) + Math.hypot(box.width, box.height) / 2;
}

/**
 * Walk each ring around the centre, placing tables shoulder to shoulder by arc
 * length. When a lap runs out of circumference the radius steps out and the
 * walk continues, so a hub with sixty dependants becomes a few tight laps
 * rather than one enormous circle. Tables are ordered by their parent's angle,
 * which keeps a cluster of dependants together and roughly under its parent.
 *
 * Tables with no foreign keys at all go last, in a band around the rim of the
 * connected diagram. The band is measured against the bulk of that diagram
 * rather than its furthest point, so one long chain of references doesn't
 * banish them to a circle twice the size of everything else.
 */
function placeRings(
  boxes: ErdLayoutBox[],
  { level, parent, mainDepth }: Placement,
  hub: number,
  px: Float64Array,
  py: Float64Array,
): { rimRadius: number } {
  const angle = new Float64Array(boxes.length);
  const depth = Math.max(...level);
  let radius = boxRadius(boxes[hub]) + GAP + RING_PADDING;

  /** Place `members` shoulder to shoulder from `radius` outward, in laps. */
  const walkRing = (members: number[]) => {
    let cursor = angle[parent[members[0]] < 0 ? hub : parent[members[0]]];
    let lapUsed = 0;
    let lapTallest = 0;

    for (const node of members) {
      const needed = (boxes[node].width + GAP) / radius;
      // A lap that would wrap past its own start steps out to the next one.
      if (lapUsed > 0 && lapUsed + needed > Math.PI * 2) {
        radius += lapTallest + GAP;
        lapUsed = 0;
        lapTallest = 0;
      }
      const span = (boxes[node].width + GAP) / radius;
      const a = cursor + span / 2;
      angle[node] = a;
      px[node] = radius * Math.cos(a);
      py[node] = radius * Math.sin(a);
      cursor += span;
      lapUsed += span;
      lapTallest = Math.max(lapTallest, boxes[node].height);
    }
    radius += lapTallest + GAP + RING_PADDING;
  };

  for (let ring = 1; ring <= Math.min(depth, mainDepth); ring++) {
    const members: number[] = [];
    for (let i = 0; i < boxes.length; i++) if (level[i] === ring) members.push(i);
    if (members.length === 0) continue;
    // Ordering by the parent's angle is what keeps siblings adjacent; the index
    // tiebreak keeps it deterministic.
    members.sort((a, b) => angle[parent[a]] - angle[parent[b]] || a - b);
    walkRing(members);
  }

  // Where the connected diagram mostly ends: the 75th percentile of how far its
  // tables reach, so a single long arm doesn't set the radius for everything.
  const reaches = [];
  for (let i = 0; i < boxes.length; i++) {
    if (level[i] <= mainDepth) reaches.push(reachOf(boxes[i], px[i], py[i]));
  }
  reaches.sort((a, b) => a - b);
  const bulk = reaches[Math.floor(reaches.length * 0.75)] ?? 0;

  const rim: number[] = [];
  for (let i = 0; i < boxes.length; i++) if (level[i] > mainDepth) rim.push(i);
  if (rim.length === 0) return { rimRadius: radius };

  // Component members stay adjacent: they share a level order and a parent.
  rim.sort((a, b) => level[a] - level[b] || parent[a] - parent[b] || a - b);
  // Measured from the bulk, not from where the last ring happened to end: a
  // single deep chain of references shouldn't drag the rim out with it. Where a
  // chain does poke through the band, `separate` nudges the pair apart.
  radius = Math.max(boxRadius(boxes[hub]) + GAP * 2, bulk + GAP + RING_PADDING);
  const rimRadius = radius;
  walkRing(rim);
  return { rimRadius };
}

export function layoutErd(boxes: ErdLayoutBox[], edges: ErdLayoutEdge[], options: ErdLayoutOptions = {}): ErdLayout {
  if (boxes.length === 0) return { nodes: [], width: 0, height: 0, centre: '' };

  if (boxes.length === 1) {
    const only = boxes[0];
    return {
      nodes: [{ ...only, x: MARGIN, y: MARGIN }],
      width: only.width + MARGIN * 2,
      height: only.height + MARGIN * 2,
      centre: only.table,
    };
  }

  const { adjacency, hub } = buildGraph(boxes, edges, options.centre);
  const rings = assignRings(adjacency, hub);

  const px = new Float64Array(boxes.length);
  const py = new Float64Array(boxes.length);
  const { rimRadius } = placeRings(boxes, rings, hub, px, py);

  const nodes: ErdLayoutNode[] = boxes.map((b, i) => ({
    ...b,
    x: px[i] - b.width / 2,
    y: py[i] - b.height / 2,
  }));

  // Rings are sized for their busiest row, so the outer ones come out airy.
  // Pulling each table inward along its own angle keeps the arrangement while
  // taking the slack out of the picture.
  compactInward(nodes, hub, rings, rimRadius);

  // Rows are sized by circumference, so a wide box can still clip its
  // neighbour; this tidies up what's left without disturbing the arrangement.
  separate(nodes, hub);

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
    centre: boxes[hub].table,
  };
}

/** Do these two boxes overlap, counting the gap that must stay between them? */
function collides(a: ErdLayoutNode, b: ErdLayoutNode): boolean {
  return a.x < b.x + b.width + GAP && b.x < a.x + a.width + GAP
    && a.y < b.y + b.height + GAP && b.y < a.y + a.height + GAP;
}

/**
 * Slide every table toward the centre along its own angle, as far as it will go
 * without touching a table already settled or crossing into a nearer ring.
 * Angles are untouched, so the radial structure survives; only the slack
 * between rings comes out — and rings stay in hop order, which is what makes
 * distance from the centre mean something.
 *
 * Innermost first, so each table settles against the ones already in place.
 * Mutates `nodes` in place.
 */
function compactInward(nodes: ErdLayoutNode[], hub: number, { level, parent, mainDepth }: Placement, rimRadius: number): void {
  const centreX = nodes[hub].x + nodes[hub].width / 2;
  const centreY = nodes[hub].y + nodes[hub].height / 2;
  const STEP = 10;

  const distanceOf = (node: ErdLayoutNode) =>
    Math.hypot(node.x + node.width / 2 - centreX, node.y + node.height / 2 - centreY);

  const order = nodes
    .map((node, i) => ({ i, distance: distanceOf(node) }))
    .filter(entry => entry.i !== hub)
    .sort((a, b) => a.distance - b.distance || a.i - b.i);

  // Two floors keep the picture honest while the slack comes out. A table that
  // references something never passes the table it hangs off, so following a
  // chain outward still means following it away from the centre. A table with
  // no foreign keys at all stays out on the rim, rather than drifting into the
  // middle where its position would read as a relationship.
  const floorFor = (i: number) => {
    if (level[i] > mainDepth) return rimRadius;
    const p = parent[i];
    if (p < 0) return 0;
    return distanceOf(nodes[p]) + Math.hypot(nodes[p].width, nodes[p].height) / 2;
  };

  const settled: ErdLayoutNode[] = [nodes[hub]];
  for (const { i, distance } of order) {
    const node = nodes[i];
    const travel = distance - Math.max(floorFor(i) + GAP, 0);
    if (distance > 0 && travel > 0) {
      const ux = (node.x + node.width / 2 - centreX) / distance;
      const uy = (node.y + node.height / 2 - centreY) / distance;
      const startX = node.x;
      const startY = node.y;
      for (let pulled = STEP; pulled <= travel; pulled += STEP) {
        const candidate = { ...node, x: startX - ux * pulled, y: startY - uy * pulled };
        if (settled.some(other => collides(candidate, other))) break;
        node.x = candidate.x;
        node.y = candidate.y;
      }
    }
    settled.push(node);
  }
}

/**
 * Push overlapping boxes apart along the line between their centres, so
 * crowding relieves in whatever direction the pair happens to lie. Pushing
 * along the axis of least overlap looks tidier for a single pair, but table
 * boxes are far wider than they are tall, so that axis is nearly always
 * vertical and a busy schema unfolds into a tall column.
 *
 * The hub stays fixed: it is the centre everything else is arranged around.
 * Mutates `nodes` in place.
 */
function separate(nodes: ErdLayoutNode[], hub: number): void {
  for (let pass = 0; pass < 80; pass++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const overlapX = Math.min(a.x + a.width + GAP, b.x + b.width + GAP) - Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + a.height + GAP, b.y + b.height + GAP) - Math.max(a.y, b.y);
        if (overlapX <= 0 || overlapY <= 0) continue;

        moved = true;
        let ux = (a.x + a.width / 2) - (b.x + b.width / 2);
        let uy = (a.y + a.height / 2) - (b.y + b.height / 2);
        const len = Math.hypot(ux, uy);
        if (len < 1e-6) {
          // Perfectly stacked: pick a direction from the pair's identity, so
          // the result is still deterministic.
          ux = Math.cos(i * 2.399963);
          uy = Math.sin(i * 2.399963);
        } else {
          ux /= len;
          uy /= len;
        }

        // Travel far enough along that direction to clear on one axis.
        const needX = Math.abs(ux) > 1e-6 ? overlapX / Math.abs(ux) : Infinity;
        const needY = Math.abs(uy) > 1e-6 ? overlapY / Math.abs(uy) : Infinity;
        const need = Math.min(needX, needY);

        // The hub doesn't move, so its partner takes the whole displacement.
        const aShare = i === hub ? 0 : j === hub ? 1 : 0.5;
        a.x += ux * need * aShare; a.y += uy * need * aShare;
        b.x -= ux * need * (1 - aShare); b.y -= uy * need * (1 - aShare);
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
