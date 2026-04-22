export interface SavedQuery {
  id: string;
  name: string;
  sql: string;
  schema: string;
  savedAt: number;
}

const MAX_PER_CONNECTION = 200;

function keyFor(conn: string): string {
  return `helix.saved-queries.${conn}`;
}

function read(conn: string): SavedQuery[] {
  try {
    const raw = localStorage.getItem(keyFor(conn));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as SavedQuery[]) : [];
  } catch {
    return [];
  }
}

function write(conn: string, list: SavedQuery[]): void {
  try { localStorage.setItem(keyFor(conn), JSON.stringify(list)); } catch {}
}

export function listSavedQueries(conn: string): SavedQuery[] {
  return conn ? read(conn) : [];
}

export function saveQuery(conn: string, entry: Omit<SavedQuery, 'id' | 'savedAt'>): SavedQuery {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const full: SavedQuery = { id, savedAt: Date.now(), ...entry };
  const list = read(conn);
  list.unshift(full);
  if (list.length > MAX_PER_CONNECTION) list.length = MAX_PER_CONNECTION;
  write(conn, list);
  return full;
}

export function deleteSavedQuery(conn: string, id: string): SavedQuery[] {
  const next = read(conn).filter(q => q.id !== id);
  write(conn, next);
  return next;
}

export function renameSavedQuery(conn: string, id: string, name: string): SavedQuery[] {
  const list = read(conn).map(q => q.id === id ? { ...q, name } : q);
  write(conn, list);
  return list;
}
