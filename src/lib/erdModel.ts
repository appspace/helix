import type { SchemaData, SchemaForeignKey, SchemaTable } from '../api';

/**
 * Turns a schema payload into the boxes and arrows the ERD draws.
 *
 * Two scopes: the whole schema, or one table's immediate neighbourhood — what
 * it references and what references it — for when the question is "what does
 * this one table depend on?". In the focused scope, relationships *between*
 * neighbours are drawn too: they are on screen anyway, and hiding them would
 * misrepresent the picture.
 *
 * A box lists only the columns that carry a relationship — primary keys and
 * foreign-key columns — because those are what the diagram is about; the rest
 * are summarised as a count. Sizing lives here too, so the layout can run on
 * plain numbers without measuring any DOM.
 */

/** Row height and header height of a table box, in SVG units. */
export const ERD_HEADER_HEIGHT = 30;
export const ERD_ROW_HEIGHT = 17;
export const ERD_MIN_WIDTH = 150;
export const ERD_MAX_WIDTH = 280;
/** Widest column list we render before collapsing the rest into "+N more". */
const MAX_ROWS = 8;
/** Approximate advance width of the 10.5px monospace used for column rows. */
const CHAR_WIDTH = 6.3;
const BOX_PADDING = 26;

export type ErdColumnKind = 'pk' | 'fk' | 'pk-fk';

export interface ErdColumn {
  name: string;
  type: string;
  kind: ErdColumnKind;
}

export interface ErdTable {
  name: string;
  /** True for the table a focused diagram is about; never true for a whole-schema one. */
  isFocus: boolean;
  /** Approximate row count, straight from the schema payload. */
  rows: number;
  /** Key columns, in table order. */
  columns: ErdColumn[];
  /** How many columns aren't shown, for the "+N more" row. */
  hiddenColumns: number;
  /** True when the table has a foreign key onto itself — drawn as a loop. */
  selfReference: boolean;
  width: number;
  height: number;
}

export interface ErdRelation {
  from: string;
  to: string;
  /** e.g. `orders.user_id → users.id` */
  label: string;
}

export interface ErdModel {
  /** The table the diagram is centred on; '' for a whole-schema diagram. */
  focus: string;
  tables: ErdTable[];
  relations: ErdRelation[];
  /** Foreign keys pointing outside the diagram — noted in the footer, not drawn. */
  crossSchemaCount: number;
}

function boxWidth(table: SchemaTable, columns: ErdColumn[]): number {
  const widest = columns.reduce(
    (max, c) => Math.max(max, (c.name.length + c.type.length + 2) * CHAR_WIDTH),
    table.name.length * CHAR_WIDTH * 1.15,
  );
  return Math.round(Math.min(ERD_MAX_WIDTH, Math.max(ERD_MIN_WIDTH, widest + BOX_PADDING)));
}

function keyColumns(table: SchemaTable): { columns: ErdColumn[]; hidden: number } {
  const fkColumns = new Set(table.foreignKeys.flatMap(fk => fk.columns));
  const all = (table.columns ?? []).filter(c => c.pk || fkColumns.has(c.name));
  const columns: ErdColumn[] = all.slice(0, MAX_ROWS).map(c => ({
    name: c.name,
    type: c.type,
    kind: c.pk && fkColumns.has(c.name) ? 'pk-fk' : c.pk ? 'pk' : 'fk',
  }));
  return { columns, hidden: (table.columns?.length ?? 0) - columns.length };
}

/** `orders.user_id → users.id`, with composite keys joined by commas. */
function relationLabel(from: string, cols: string[], to: string, refCols: string[]): string {
  return `${from}.${cols.join(', ')} → ${to}.${refCols.join(', ')}`;
}

/** Does this foreign key point at a table on this diagram? */
function resolvesWithin(fk: SchemaForeignKey, activeSchema: string, known: Set<string>): boolean {
  // An empty referencedSchema means the driver didn't qualify it, which only
  // happens for a same-schema reference.
  const sameSchema = !fk.referencedSchema || fk.referencedSchema === activeSchema;
  return sameSchema && known.has(fk.referencedTable);
}

/** The focus table plus everything one hop away in either direction. */
function neighbourhood(allTables: SchemaTable[], focus: SchemaTable, activeSchema: string, known: Set<string>): Set<string> {
  const names = new Set<string>([focus.name]);
  for (const fk of focus.foreignKeys ?? []) {
    if (resolvesWithin(fk, activeSchema, known)) names.add(fk.referencedTable);
  }
  for (const table of allTables) {
    for (const fk of table.foreignKeys ?? []) {
      if (fk.referencedTable === focus.name && resolvesWithin(fk, activeSchema, known)) {
        names.add(table.name);
      }
    }
  }
  return names;
}

/**
 * @param focusTable one table to centre on, or null/'' for the whole schema.
 */
export function buildErdModel(schema: SchemaData, activeSchema: string, focusTable?: string | null): ErdModel {
  const allTables = schema.tables ?? [];
  const known = new Set(allTables.map(t => t.name));

  const focus = focusTable ? allTables.find(t => t.name === focusTable) : undefined;
  // A named table that isn't in the payload has nothing to draw — don't quietly
  // fall back to the whole schema, which isn't what was asked for.
  if (focusTable && !focus) return { focus: '', tables: [], relations: [], crossSchemaCount: 0 };

  const shown = focus ? neighbourhood(allTables, focus, activeSchema, known) : known;
  const sourceTables = focus ? allTables.filter(t => shown.has(t.name)) : allTables;
  const crossSchemaCount = (focus ? [focus] : allTables)
    .flatMap(t => t.foreignKeys ?? [])
    .filter(fk => !resolvesWithin(fk, activeSchema, known)).length;

  const tables: ErdTable[] = sourceTables.map(table => {
    const { columns, hidden } = keyColumns(table);
    const rowCount = columns.length + (hidden > 0 ? 1 : 0);
    return {
      name: table.name,
      isFocus: table.name === focus?.name,
      rows: table.rows,
      columns,
      hiddenColumns: Math.max(0, hidden),
      selfReference: (table.foreignKeys ?? []).some(fk => fk.referencedTable === table.name),
      width: boxWidth(table, columns),
      height: ERD_HEADER_HEIGHT + rowCount * ERD_ROW_HEIGHT + 6,
    };
  });

  // Every relationship with both ends on the diagram, so neighbours that are
  // related to each other don't look unconnected.
  const relations: ErdRelation[] = [];
  for (const table of sourceTables) {
    for (const fk of table.foreignKeys ?? []) {
      if (!resolvesWithin(fk, activeSchema, known) || !shown.has(fk.referencedTable)) continue;
      relations.push({
        from: table.name,
        to: fk.referencedTable,
        label: relationLabel(table.name, fk.columns, fk.referencedTable, fk.referencedColumns),
      });
    }
  }

  return { focus: focus?.name ?? '', tables, relations, crossSchemaCount };
}
