import { describe, it, expect } from 'vitest';
import { layoutErd, borderPoint } from './erdLayout';
import type { ErdLayoutBox, ErdLayoutEdge, ErdLayoutNode } from './erdLayout';

function boxes(...names: string[]): ErdLayoutBox[] {
  return names.map(table => ({ table, width: 180, height: 90 }));
}

function byName(nodes: ErdLayoutNode[]): Record<string, ErdLayoutNode> {
  return Object.fromEntries(nodes.map(n => [n.table, n]));
}

function centre(node: ErdLayoutNode): { x: number; y: number } {
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}

function centreDistance(a: ErdLayoutNode, b: ErdLayoutNode): number {
  return Math.hypot(centre(a).x - centre(b).x, centre(a).y - centre(b).y);
}

function overlaps(a: ErdLayoutNode, b: ErdLayoutNode): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width
    && a.y < b.y + b.height && b.y < a.y + a.height;
}

function expectNoOverlaps(nodes: ErdLayoutNode[]): void {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      expect(overlaps(nodes[i], nodes[j]), `${nodes[i].table} overlaps ${nodes[j].table}`).toBe(false);
    }
  }
}

/** A hub with `spokes` tables pointing at it, plus any unconnected extras. */
function hubAndSpokes(spokes: number, orphans = 0): { boxes: ErdLayoutBox[]; edges: ErdLayoutEdge[] } {
  const names = ['hub', ...Array.from({ length: spokes }, (_, i) => `spoke_${i}`)];
  const extras = Array.from({ length: orphans }, (_, i) => `orphan_${i}`);
  return {
    boxes: boxes(...names, ...extras),
    edges: Array.from({ length: spokes }, (_, i) => ({ from: `spoke_${i}`, to: 'hub' })),
  };
}

describe('layoutErd', () => {
  it('returns nothing for an empty schema', () => {
    expect(layoutErd([], [])).toEqual({ nodes: [], width: 0, height: 0, centre: '' });
  });

  it('places a lone table at the margin', () => {
    const { nodes, width, height, centre: hub } = layoutErd(boxes('users'), []);
    expect(nodes).toEqual([{ table: 'users', width: 180, height: 90, x: 40, y: 40 }]);
    expect({ width, height }).toEqual({ width: 260, height: 170 });
    expect(hub).toBe('users');
  });

  it('keeps one node per table and preserves the box sizes it was given', () => {
    const sized: ErdLayoutBox[] = [
      { table: 'users', width: 180, height: 90 },
      { table: 'orders', width: 220, height: 140 },
    ];
    const { nodes } = layoutErd(sized, [{ from: 'orders', to: 'users' }]);
    expect(nodes.map(n => n.table).sort()).toEqual(['orders', 'users']);
    expect(byName(nodes)['orders'].width).toBe(220);
    expect(byName(nodes)['orders'].height).toBe(140);
  });

  it('is deterministic — the same schema lays out the same way twice', () => {
    const b = boxes('users', 'orders', 'items', 'invoices', 'payments');
    const e: ErdLayoutEdge[] = [
      { from: 'orders', to: 'users' },
      { from: 'items', to: 'orders' },
      { from: 'invoices', to: 'orders' },
      { from: 'payments', to: 'invoices' },
    ];
    expect(layoutErd(b, e)).toEqual(layoutErd(b, e));
  });

  it('normalises the diagram to start at the margin', () => {
    const { nodes, width, height } = layoutErd(boxes('a', 'b', 'c', 'd'), [{ from: 'a', to: 'b' }]);
    expect(Math.min(...nodes.map(n => n.x))).toBeCloseTo(40, 6);
    expect(Math.min(...nodes.map(n => n.y))).toBeCloseTo(40, 6);
    expect(Math.max(...nodes.map(n => n.x + n.width))).toBeLessThanOrEqual(width - 40 + 1e-6);
    expect(Math.max(...nodes.map(n => n.y + n.height))).toBeLessThanOrEqual(height - 40 + 1e-6);
  });

  it('produces finite coordinates for every node', () => {
    const { nodes } = layoutErd(boxes('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'), [
      { from: 'a', to: 'b' }, { from: 'c', to: 'a' }, { from: 'd', to: 'a' },
    ]);
    for (const n of nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
  });

  it('leaves no two boxes overlapping', () => {
    const b = boxes('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l');
    const e: ErdLayoutEdge[] = [
      { from: 'b', to: 'a' }, { from: 'c', to: 'a' }, { from: 'd', to: 'a' },
      { from: 'e', to: 'a' }, { from: 'f', to: 'a' }, { from: 'g', to: 'b' },
    ];
    expectNoOverlaps(layoutErd(b, e).nodes);
  });
});

describe('layoutErd — the centre', () => {
  it('builds the diagram around the most-connected table', () => {
    const { boxes: b, edges } = hubAndSpokes(5);
    expect(layoutErd(b, edges).centre).toBe('hub');
  });

  it('honours a requested centre even when another table has more relationships', () => {
    const { boxes: b, edges } = hubAndSpokes(5);
    const layout = layoutErd(b, edges, { centre: 'spoke_2' });
    expect(layout.centre).toBe('spoke_2');
  });

  it('falls back to the most-connected table when the requested one is not on the diagram', () => {
    const { boxes: b, edges } = hubAndSpokes(5);
    expect(layoutErd(b, edges, { centre: 'ghost' }).centre).toBe('hub');
    expect(layoutErd(b, edges, { centre: null }).centre).toBe('hub');
  });

  it('puts the centre table in the middle of the diagram', () => {
    const { boxes: b, edges } = hubAndSpokes(24);
    const layout = layoutErd(b, edges);
    const hub = centre(byName(layout.nodes)['hub']);
    // Within a tenth of the diagram of dead centre on both axes.
    expect(Math.abs(hub.x - layout.width / 2)).toBeLessThan(layout.width * 0.1);
    expect(Math.abs(hub.y - layout.height / 2)).toBeLessThan(layout.height * 0.1);
  });

  it('surrounds the centre rather than stacking beside it', () => {
    const { boxes: b, edges } = hubAndSpokes(16);
    const layout = layoutErd(b, edges);
    const hub = centre(byName(layout.nodes)['hub']);
    const spokes = layout.nodes.filter(n => n.table !== 'hub').map(centre);
    // Spokes on every side: at least a quarter of them left, right, above and below.
    const quarter = spokes.length / 4;
    expect(spokes.filter(s => s.x < hub.x).length).toBeGreaterThanOrEqual(quarter);
    expect(spokes.filter(s => s.x > hub.x).length).toBeGreaterThanOrEqual(quarter);
    expect(spokes.filter(s => s.y < hub.y).length).toBeGreaterThanOrEqual(quarter);
    expect(spokes.filter(s => s.y > hub.y).length).toBeGreaterThanOrEqual(quarter);
  });

  it('keeps a crowded schema roughly square instead of unfolding it into a column', () => {
    // The regression this layout exists for: 60 dependants and a tail of
    // unconnected tables used to separate almost entirely along Y, producing a
    // tall spike of a diagram.
    const { boxes: b, edges } = hubAndSpokes(60, 20);
    const layout = layoutErd(b, edges);
    const aspect = Math.max(layout.width, layout.height) / Math.min(layout.width, layout.height);
    expect(aspect).toBeLessThan(1.8);
    expectNoOverlaps(layout.nodes);
  });

  it('keeps unconnected tables further out than the ones that reference the centre', () => {
    const { boxes: b, edges } = hubAndSpokes(6, 4);
    const nodes = byName(layoutErd(b, edges).nodes);
    const hub = nodes['hub'];
    const nearestOrphan = Math.min(...[0, 1, 2, 3].map(i => centreDistance(hub, nodes[`orphan_${i}`])));
    const furthestSpoke = Math.max(...[0, 1, 2, 3, 4, 5].map(i => centreDistance(hub, nodes[`spoke_${i}`])));
    expect(nearestOrphan).toBeGreaterThan(furthestSpoke);
  });

  it('places a second hop beyond the first', () => {
    const b = boxes('hub', 'near', 'far');
    const nodes = byName(layoutErd(b, [{ from: 'near', to: 'hub' }, { from: 'far', to: 'near' }]).nodes);
    expect(centreDistance(nodes['hub'], nodes['far'])).toBeGreaterThan(centreDistance(nodes['hub'], nodes['near']));
  });
});

describe('layoutErd — edge cases', () => {
  it('ignores a self-reference rather than collapsing the node', () => {
    const { nodes } = layoutErd(boxes('employees', 'departments'), [
      { from: 'employees', to: 'employees' },
      { from: 'employees', to: 'departments' },
    ]);
    for (const n of nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
    expectNoOverlaps(nodes);
  });

  it('ignores an edge pointing at a table outside the diagram', () => {
    const withDangling = layoutErd(boxes('orders', 'users'), [
      { from: 'orders', to: 'archive_in_another_schema' },
      { from: 'orders', to: 'users' },
    ]);
    const without = layoutErd(boxes('orders', 'users'), [{ from: 'orders', to: 'users' }]);
    expect(withDangling).toEqual(without);
  });

  it('separates tables that share no foreign keys at all', () => {
    expectNoOverlaps(layoutErd(boxes('a', 'b', 'c', 'd', 'e'), []).nodes);
  });

  it('handles a long chain without exploding the diagram', () => {
    const names = Array.from({ length: 15 }, (_, i) => `t${i}`);
    const edges = names.slice(1).map((name, i) => ({ from: name, to: names[i] }));
    const layout = layoutErd(boxes(...names), edges);
    expectNoOverlaps(layout.nodes);
    // A chain is inherently long, but it should stay in the same order of
    // magnitude as the boxes themselves rather than growing exponentially.
    expect(layout.width).toBeLessThan(180 * names.length * 2);
    expect(layout.height).toBeLessThan(180 * names.length * 2);
  });
});

describe('borderPoint', () => {
  const from: ErdLayoutNode = { table: 'a', width: 200, height: 100, x: 0, y: 0 };

  it('leaves through the right edge for a box to the right', () => {
    const to: ErdLayoutNode = { table: 'b', width: 200, height: 100, x: 400, y: 0 };
    expect(borderPoint(from, to)).toEqual({ x: 200, y: 50 });
  });

  it('leaves through the bottom edge for a box below', () => {
    const to: ErdLayoutNode = { table: 'b', width: 200, height: 100, x: 0, y: 400 };
    expect(borderPoint(from, to)).toEqual({ x: 100, y: 100 });
  });

  it('leaves through the left edge for a box to the left', () => {
    const to: ErdLayoutNode = { table: 'b', width: 200, height: 100, x: -400, y: 0 };
    expect(borderPoint(from, to)).toEqual({ x: 0, y: 50 });
  });

  it('lands on the border for a diagonal neighbour', () => {
    const to: ErdLayoutNode = { table: 'b', width: 200, height: 100, x: 300, y: 300 };
    const p = borderPoint(from, to);
    const onVertical = Math.abs(p.x - 200) < 1e-6;
    const onHorizontal = Math.abs(p.y - 100) < 1e-6;
    expect(onVertical || onHorizontal).toBe(true);
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.y).toBeGreaterThanOrEqual(0);
  });

  it('falls back to the centre for two boxes at the same spot', () => {
    expect(borderPoint(from, { ...from, table: 'b' })).toEqual({ x: 100, y: 50 });
  });
});
