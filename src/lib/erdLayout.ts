/**
 * Radial, cluster-first placement for the foreign-key diagram.
 *
 * The diagram has a centre — the focus table, or the most-connected one. Its
 * dependants ring it, and from there every table's own dependants fan out
 * *from that table*, pointing away from the centre, in the wedge of the circle
 * its subtree was given. So a cluster is drawn as a cluster: `shipment` and the
 * dozen tables that reference it sit together in their own quarter, rather than
 * being smeared around a shared ring with everyone else at the same hop.
 *
 * The wedge each table gets is proportional to the arc its whole subtree needs,
 * so a busy branch is given room and a leaf isn't. A cluster too big for its
 * wedge stacks into two or three rows inside it rather than borrowing arc from
 * its neighbours. Tables with no foreign keys at all sit in a band around the
 * rim, out of the way of the structure.
 *
 * Two earlier versions are worth remembering. A spiral seed relaxed by a force
 * simulation collapsed under gravity, and the overlap pass then unfolded the
 * pile along whichever axis two boxes overlapped least — nearly always the
 * vertical one, table boxes being far wider than tall — so a real schema came
 * out as a tall plume. Plain rings fixed the shape but not the reading: a
 * table's dependants spanned a median arc of 187° of the diagram. Hence both
 * the fans below and the centre-line separation, which has no preferred axis.
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
/** How many rows a cluster may stack inside its own wedge before the wedge just gets wider. */
const MAX_CLUSTER_ROWS = 3;

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
  /** Dependants of each table, in the order they were reached. */
  children: number[][];
  /** Breadth-first visit order, roots first. */
  order: number[];
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
  const children: number[][] = Array.from({ length: n }, () => []);
  const order: number[] = [];
  level[hub] = 0;

  const walk = (queue: number[]) => {
    for (let head = 0; head < queue.length; head++) {
      const v = queue[head];
      order.push(v);
      for (const w of adjacency[v]) {
        if (level[w] !== -1) continue;
        level[w] = level[v] + 1;
        parent[w] = v;
        children[v].push(w);
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
    children[hub].push(root);
    walk([root]);
  }

  return { level, parent, children, order, mainDepth };
}

/** Distance from the centre to a box's far corner. */
function reachOf(box: ErdLayoutBox, x: number, y: number): number {
  return Math.hypot(x, y) + Math.hypot(box.width, box.height) / 2;
}

/**
 * How much arc a subtree needs: enough for the table itself, or for everything
 * hanging off it, whichever is greater. Sectors are handed out in proportion to
 * this, so a table with a big cluster of dependants gets a wide wedge and a
 * leaf gets a narrow one.
 */
function arcDemand(boxes: ErdLayoutBox[], children: number[][], order: number[]): number[] {
  const demand = boxes.map(b => b.width + GAP);
  // `order` is breadth-first, so walking it backwards visits children first.
  for (let i = order.length - 1; i >= 0; i--) {
    const v = order[i];
    let below = 0;
    for (const c of children[v]) below += demand[c];
    demand[v] = Math.max(demand[v], below);
  }
  return demand;
}

/** Widest fan a cluster may open, so it never wraps back over its own parent. */
const MAX_FAN_ANGLE = Math.PI * 1.2;

/**
 * Arrange `members` on an arc around a point, filling the given angular span
 * and stacking into further rows when one arc can't hold them all. Each member
 * keeps the slice of the span it was given, which is what its own dependants
 * fan out into later.
 */
function fanOut(
  boxes: ErdLayoutBox[],
  members: number[],
  demand: number[],
  sectorStart: Float64Array,
  sectorSpan: Float64Array,
  px: Float64Array,
  py: Float64Array,
  layout: { originX: number; originY: number; from: number; span: number; distance: number; rowStep: number },
): void {
  if (members.length === 0) return;
  const { originX, originY, from, span, distance, rowStep } = layout;

  const needed = members.reduce((sum, c) => sum + boxes[c].width + GAP, 0);
  const rows = Math.max(1, Math.min(MAX_CLUSTER_ROWS, Math.ceil(needed / Math.max(span * distance, 1))));
  const perRow = needed / rows;

  const rowMembers: number[][] = Array.from({ length: rows }, () => []);
  let row = 0;
  let filled = 0;
  for (const c of members) {
    const cost = boxes[c].width + GAP;
    if (row < rows - 1 && filled > 0 && filled + cost > perRow) { row++; filled = 0; }
    rowMembers[row].push(c);
    filled += cost;
  }

  rowMembers.forEach((inRow, i) => {
    if (inRow.length === 0) return;
    const rowRadius = distance + i * rowStep;
    const total = inRow.reduce((sum, c) => sum + demand[c], 0) || 1;
    let cursor = from;
    for (const c of inRow) {
      const slice = (demand[c] / total) * span;
      sectorStart[c] = cursor;
      sectorSpan[c] = slice;
      const angle = cursor + slice / 2;
      px[c] = originX + rowRadius * Math.cos(angle);
      py[c] = originY + rowRadius * Math.sin(angle);
      cursor += slice;
    }
  });
}

/**
 * Place the connected tables: the centre's dependants ring it, and every
 * cluster past that fans out from the table it belongs to.
 *
 * Each table owns an angular sector, split among its dependants in proportion
 * to the arc their own subtrees need, so a cluster keeps its own wedge of the
 * diagram. Where a wedge is too narrow for a cluster, it stacks into rows
 * inside that wedge rather than borrowing arc from its neighbours.
 */
function placeClusters(
  boxes: ErdLayoutBox[],
  { level, parent, children, mainDepth, order }: Placement,
  hub: number,
  px: Float64Array,
  py: Float64Array,
): { rimRadius: number } {
  const demand = arcDemand(boxes, children, order);
  const sectorStart = new Float64Array(boxes.length);
  const sectorSpan = new Float64Array(boxes.length);
  sectorStart[hub] = 0;
  sectorSpan[hub] = Math.PI * 2;

  let radius = boxRadius(boxes[hub]) + GAP + RING_PADDING;

  for (let ring = 1; ring <= mainDepth; ring++) {
    const parents: number[] = [];
    for (let i = 0; i < boxes.length; i++) {
      if (level[i] === ring - 1 && children[i].some(c => level[c] === ring)) parents.push(i);
    }
    if (parents.length === 0) continue;

    let tallest = 0;
    let ringArc = 0;
    for (let i = 0; i < boxes.length; i++) {
      if (level[i] !== ring) continue;
      ringArc += boxes[i].width + GAP;
      tallest = Math.max(tallest, boxes[i].height);
    }

    if (ring === 1) {
      // The centre's own dependants ring it, stacking into rows when one lap
      // can't hold them. Wide enough for the ring, counting those rows.
      radius = Math.max(radius, ringArc / (Math.PI * 2 * MAX_CLUSTER_ROWS));
      fanOut(boxes, children[hub], demand, sectorStart, sectorSpan, px, py, {
        originX: 0, originY: 0, from: 0, span: Math.PI * 2, distance: radius, rowStep: tallest + GAP,
      });
      continue;
    }

    // Deeper rings cluster around the table they belong to: each parent's
    // dependants fan out from it, pointing away from the centre. This is what
    // makes a cluster read as a cluster instead of another arc of a ring.
    for (const p of parents) {
      const kids = children[p].filter(c => level[c] === ring);
      const outward = Math.atan2(py[p], px[p]);
      // The parent's share of the circle, but never so wide that the fan wraps
      // back over the parent itself.
      const wedge = Math.min(sectorSpan[p], MAX_FAN_ANGLE);
      const widestKid = Math.max(...kids.map(c => boxRadius(boxes[c])));
      const distance = boxRadius(boxes[p]) + widestKid + GAP + RING_PADDING;
      fanOut(boxes, kids, demand, sectorStart, sectorSpan, px, py, {
        originX: px[p], originY: py[p], from: outward - wedge / 2, span: wedge,
        distance, rowStep: tallest + GAP,
      });
    }
  }

  // Where the connected diagram mostly ends: the 75th percentile of how far its
  // tables reach, so a single long chain doesn't set the radius for everything.
  const reaches: number[] = [];
  for (let i = 0; i < boxes.length; i++) {
    if (level[i] <= mainDepth) reaches.push(reachOf(boxes[i], px[i], py[i]));
  }
  reaches.sort((a, b) => a - b);
  const bulk = reaches[Math.floor(reaches.length * 0.75)] ?? 0;

  const rim: number[] = [];
  for (let i = 0; i < boxes.length; i++) if (level[i] > mainDepth) rim.push(i);
  if (rim.length === 0) return { rimRadius: radius };

  // Tables with no foreign keys ring the rim, shoulder to shoulder. Where a
  // long chain pokes through the band, `separate` nudges the pair apart.
  rim.sort((a, b) => level[a] - level[b] || parent[a] - parent[b] || a - b);
  const rimRadius = Math.max(boxRadius(boxes[hub]) + GAP * 2, bulk + GAP + RING_PADDING);
  let rimRing = rimRadius;
  let cursor = 0;
  let lapUsed = 0;
  let lapTallest = 0;
  for (const node of rim) {
    const span = (boxes[node].width + GAP) / rimRing;
    if (lapUsed > 0 && lapUsed + span > Math.PI * 2) {
      rimRing += lapTallest + GAP;
      lapUsed = 0;
      lapTallest = 0;
    }
    const angle = cursor + span / 2;
    px[node] = rimRing * Math.cos(angle);
    py[node] = rimRing * Math.sin(angle);
    cursor += span;
    lapUsed += span;
    lapTallest = Math.max(lapTallest, boxes[node].height);
  }

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
  const { rimRadius } = placeClusters(boxes, rings, hub, px, py);

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
