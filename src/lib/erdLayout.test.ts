import { describe, it, expect } from 'vitest';
import { layoutErd, borderPoint } from './erdLayout';
import type { ErdLayoutBox, ErdLayoutEdge, ErdLayoutNode } from './erdLayout';

function boxes(...names: string[]): ErdLayoutBox[] {
  return names.map(table => ({ table, width: 180, height: 90 }));
}

function byName(nodes: ErdLayoutNode[]): Record<string, ErdLayoutNode> {
  return Object.fromEntries(nodes.map(n => [n.table, n]));
}

function centreDistance(a: ErdLayoutNode, b: ErdLayoutNode): number {
  return Math.hypot(
    (a.x + a.width / 2) - (b.x + b.width / 2),
    (a.y + a.height / 2) - (b.y + b.height / 2),
  );
}

function overlaps(a: ErdLayoutNode, b: ErdLayoutNode): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width
    && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe('layoutErd', () => {
  it('returns nothing for an empty schema', () => {
    expect(layoutErd([], [])).toEqual({ nodes: [], width: 0, height: 0 });
  });

  it('places a lone table at the margin', () => {
    const { nodes, width, height } = layoutErd(boxes('users'), []);
    expect(nodes).toEqual([{ table: 'users', width: 180, height: 90, x: 40, y: 40 }]);
    expect({ width, height }).toEqual({ width: 260, height: 170 });
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
    const { nodes } = layoutErd(b, e);
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        expect(overlaps(nodes[i], nodes[j])).toBe(false);
      }
    }
  });

  it('pulls tables joined by a foreign key closer than unrelated ones', () => {
    const linked = layoutErd(boxes('orders', 'users'), [{ from: 'orders', to: 'users' }]).nodes;
    const loose = layoutErd(boxes('orders', 'users'), []).nodes;
    expect(centreDistance(linked[0], linked[1])).toBeLessThan(centreDistance(loose[0], loose[1]));
  });

  it('ignores a self-reference rather than collapsing the node', () => {
    const { nodes } = layoutErd(boxes('employees', 'departments'), [
      { from: 'employees', to: 'employees' },
      { from: 'employees', to: 'departments' },
    ]);
    for (const n of nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
    expect(overlaps(nodes[0], nodes[1])).toBe(false);
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
    const { nodes } = layoutErd(boxes('a', 'b', 'c', 'd', 'e'), []);
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        expect(overlaps(nodes[i], nodes[j])).toBe(false);
      }
    }
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
