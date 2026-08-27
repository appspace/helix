import { describe, it, expect } from 'vitest';
import { buildErdModel, ERD_HEADER_HEIGHT, ERD_ROW_HEIGHT, ERD_MIN_WIDTH, ERD_MAX_WIDTH } from './erdModel';
import type { SchemaColumn, SchemaData, SchemaForeignKey, SchemaTable } from '../api';

function col(name: string, opts: Partial<SchemaColumn> = {}): SchemaColumn {
  return {
    name, type: 'int', dataType: 'int', pk: false, nullable: true,
    default: null, autoIncrement: false, comment: '', ...opts,
  };
}

function fk(name: string, columns: string[], referencedTable: string, referencedColumns: string[], referencedSchema = 'shop'): SchemaForeignKey {
  return { name, columns, referencedSchema, referencedTable, referencedColumns };
}

function table(name: string, columns: SchemaColumn[], foreignKeys: SchemaForeignKey[] = []): SchemaTable {
  return { name, rows: 0, comment: '', columns, indexes: [], foreignKeys };
}

function schema(...tables: SchemaTable[]): SchemaData {
  return { tables, views: [], procedures: [], triggers: [] };
}

const USERS = table('users', [col('id', { pk: true }), col('email', { type: 'varchar(255)' })]);
const ORDERS = table(
  'orders',
  [col('id', { pk: true }), col('user_id'), col('total', { type: 'decimal(10,2)' })],
  [fk('fk_orders_user', ['user_id'], 'users', ['id'])],
);

describe('buildErdModel — tables', () => {
  it('shows key columns only and counts the rest', () => {
    const { tables } = buildErdModel(schema(ORDERS), 'shop', null);
    expect(tables[0].columns.map(c => c.name)).toEqual(['id', 'user_id']);
    expect(tables[0].hiddenColumns).toBe(1);
  });

  it('labels each column by the role that puts it on the diagram', () => {
    const items = table(
      'order_items',
      [col('order_id', { pk: true }), col('sku'), col('warehouse_id')],
      [fk('fk_items_order', ['order_id'], 'orders', ['id']), fk('fk_items_wh', ['warehouse_id'], 'warehouses', ['id'])],
    );
    const { tables } = buildErdModel(schema(items), 'shop', null);
    expect(tables[0].columns.map(c => [c.name, c.kind])).toEqual([
      ['order_id', 'pk-fk'],
      ['warehouse_id', 'fk'],
    ]);
  });

  it('keeps a table with no key columns as an empty box', () => {
    const logs = table('logs', [col('message', { type: 'text' })]);
    const { tables } = buildErdModel(schema(logs), 'shop', null);
    expect(tables[0].columns).toEqual([]);
    expect(tables[0].hiddenColumns).toBe(1);
  });

  it('caps the column list and folds the remainder into the hidden count', () => {
    const wide = table(
      'wide',
      Array.from({ length: 12 }, (_, i) => col(`c${i}`, { pk: true })),
    );
    const { tables } = buildErdModel(schema(wide), 'shop', null);
    expect(tables[0].columns).toHaveLength(8);
    expect(tables[0].hiddenColumns).toBe(4);
  });

  it('sizes the box from its header and rows', () => {
    const { tables } = buildErdModel(schema(ORDERS), 'shop', null);
    // 2 key columns + 1 "+N more" row
    expect(tables[0].height).toBe(ERD_HEADER_HEIGHT + 3 * ERD_ROW_HEIGHT + 6);
  });

  it('keeps box widths within the readable range', () => {
    const long = table('a_table_with_an_extremely_long_name_that_would_run_off', [
      col('a_column_name_that_is_also_far_too_long_to_show_in_full', { pk: true, type: 'varchar(255)' }),
    ]);
    const short = table('t', [col('id', { pk: true })]);
    const { tables } = buildErdModel(schema(long, short), 'shop', null);
    expect(tables[0].width).toBe(ERD_MAX_WIDTH);
    expect(tables[1].width).toBe(ERD_MIN_WIDTH);
  });

  it('tolerates a schema with no tables', () => {
    expect(buildErdModel(schema(), 'shop', null)).toEqual({ focus: '', tables: [], relations: [], crossSchemaCount: 0 });
  });
});

describe('buildErdModel — relations', () => {
  it('builds one relation per foreign key, labelled with both sides', () => {
    const { relations } = buildErdModel(schema(ORDERS, USERS), 'shop', null);
    expect(relations).toEqual([
      { from: 'orders', to: 'users', label: 'orders.user_id → users.id' },
    ]);
  });

  it('labels a composite key with every column pair', () => {
    const items = table(
      'order_items',
      [col('order_tenant'), col('order_id')],
      [fk('fk_items_order', ['order_tenant', 'order_id'], 'orders', ['tenant', 'id'])],
    );
    const { relations } = buildErdModel(schema(items, ORDERS), 'shop', null);
    expect(relations[0].label).toBe('order_items.order_tenant, order_id → orders.tenant, id');
  });

  it('counts a cross-schema reference instead of drawing it', () => {
    const orders = table('orders', [col('tenant_id')], [fk('fk_tenant', ['tenant_id'], 'tenants', ['id'], 'directory')]);
    const model = buildErdModel(schema(orders), 'shop', null);
    expect(model.relations).toEqual([]);
    expect(model.crossSchemaCount).toBe(1);
  });

  it('counts a reference to a table missing from the payload', () => {
    const model = buildErdModel(schema(ORDERS), 'shop', null);
    expect(model.relations).toEqual([]);
    expect(model.crossSchemaCount).toBe(1);
  });

  it('treats an unqualified referenced schema as the active one', () => {
    const orders = table('orders', [col('user_id')], [fk('fk_orders_user', ['user_id'], 'users', ['id'], '')]);
    const { relations } = buildErdModel(schema(orders, USERS), 'shop', null);
    expect(relations).toHaveLength(1);
  });

  it('keeps a self-reference as a relation and flags the table', () => {
    const employees = table(
      'employees',
      [col('id', { pk: true }), col('manager_id')],
      [fk('fk_manager', ['manager_id'], 'employees', ['id'])],
    );
    const model = buildErdModel(schema(employees), 'shop', null);
    expect(model.tables[0].selfReference).toBe(true);
    expect(model.relations).toEqual([
      { from: 'employees', to: 'employees', label: 'employees.manager_id → employees.id' },
    ]);
  });

  it('reports no relations for a schema without foreign keys', () => {
    const model = buildErdModel(schema(USERS, table('logs', [col('id', { pk: true })])), 'shop', null);
    expect(model.relations).toEqual([]);
    expect(model.crossSchemaCount).toBe(0);
  });
});

describe('buildErdModel — one table in focus', () => {
  const ADDRESSES = table(
    'addresses',
    [col('id', { pk: true }), col('user_id')],
    [fk('fk_addresses_user', ['user_id'], 'users', ['id'])],
  );
  const ORDERS_FULL = table(
    'orders',
    [col('id', { pk: true }), col('user_id'), col('address_id')],
    [fk('fk_orders_user', ['user_id'], 'users', ['id']), fk('fk_orders_address', ['address_id'], 'addresses', ['id'])],
  );
  const PAYMENTS = table(
    'payments',
    [col('id', { pk: true }), col('order_id')],
    [fk('fk_payments_order', ['order_id'], 'orders', ['id'])],
  );
  const UNRELATED = table('audit_log', [col('id', { pk: true })]);
  const SHOP = schema(ADDRESSES, UNRELATED, ORDERS_FULL, PAYMENTS, USERS);

  it('keeps the focus table, what it references, and what references it', () => {
    const model = buildErdModel(SHOP, 'shop', 'orders');
    expect(model.tables.map(t => t.name).sort()).toEqual(['addresses', 'orders', 'payments', 'users']);
    expect(model.focus).toBe('orders');
  });

  it('leaves out tables more than one hop away', () => {
    const model = buildErdModel(SHOP, 'shop', 'payments');
    expect(model.tables.map(t => t.name).sort()).toEqual(['orders', 'payments']);
  });

  it('flags exactly one table as the focus', () => {
    const model = buildErdModel(SHOP, 'shop', 'orders');
    expect(model.tables.filter(t => t.isFocus).map(t => t.name)).toEqual(['orders']);
  });

  it('draws relationships between the neighbours too, not just the focus ones', () => {
    const model = buildErdModel(SHOP, 'shop', 'orders');
    // addresses → users is neither from nor to the focus table, but both ends are on screen.
    expect(model.relations).toContainEqual({
      from: 'addresses', to: 'users', label: 'addresses.user_id → users.id',
    });
  });

  it('drops relationships whose other end is off the diagram', () => {
    const model = buildErdModel(SHOP, 'shop', 'users');
    // payments → orders is two hops from users and must not appear.
    expect(model.relations.every(r => r.from !== 'payments')).toBe(true);
  });

  it('shows a table with no relationships on its own', () => {
    const model = buildErdModel(SHOP, 'shop', 'audit_log');
    expect(model.tables.map(t => t.name)).toEqual(['audit_log']);
    expect(model.relations).toEqual([]);
  });

  it('keeps a self-referencing table alone with its own loop', () => {
    const employees = table(
      'employees',
      [col('id', { pk: true }), col('manager_id')],
      [fk('fk_manager', ['manager_id'], 'employees', ['id'])],
    );
    const model = buildErdModel(schema(employees, UNRELATED), 'shop', 'employees');
    expect(model.tables.map(t => t.name)).toEqual(['employees']);
    expect(model.relations).toEqual([
      { from: 'employees', to: 'employees', label: 'employees.manager_id → employees.id' },
    ]);
  });

  it('counts only the focus table\'s references that point outside the schema', () => {
    const orders = table('orders', [col('tenant_id'), col('user_id')], [
      fk('fk_tenant', ['tenant_id'], 'tenants', ['id'], 'directory'),
      fk('fk_orders_user', ['user_id'], 'users', ['id']),
    ]);
    const other = table('other', [col('x_id')], [fk('fk_other', ['x_id'], 'elsewhere', ['id'], 'directory')]);
    const model = buildErdModel(schema(orders, other, USERS), 'shop', 'orders');
    expect(model.crossSchemaCount).toBe(1);
  });

  it('returns nothing for a table that is not in the schema', () => {
    expect(buildErdModel(SHOP, 'shop', 'ghost')).toEqual({ focus: '', tables: [], relations: [], crossSchemaCount: 0 });
  });

  it('falls back to the whole schema only when no table is named', () => {
    expect(buildErdModel(SHOP, 'shop', null).tables).toHaveLength(5);
    expect(buildErdModel(SHOP, 'shop').tables).toHaveLength(5);
    expect(buildErdModel(SHOP, 'shop', '').focus).toBe('');
  });
});
