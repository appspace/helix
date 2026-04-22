export interface HistoryEntry {
  id: string;
  sql: string;
  schema: string;
  executedAt: number;          // ms since epoch
  durationMs: number | null;
  status: 'ok' | 'error';
  rowCount?: number;
  error?: string;
}

const MAX_PER_CONNECTION = 100;

function keyFor(conn: string): string {
  return `helix.history.${conn}`;
}

function read(conn: string): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(keyFor(conn));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function write(conn: string, list: HistoryEntry[]): void {
  try { localStorage.setItem(keyFor(conn), JSON.stringify(list)); } catch { /* quota / disabled — ignore */ }
}

export function listHistory(conn: string): HistoryEntry[] {
  return conn ? read(conn) : [];
}

export function addHistoryEntry(
  conn: string,
  entry: Omit<HistoryEntry, 'id'>,
): HistoryEntry | null {
  if (!conn) return null;
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const full: HistoryEntry = { id, ...entry };
  const list = read(conn);
  list.unshift(full);
  if (list.length > MAX_PER_CONNECTION) list.length = MAX_PER_CONNECTION;
  write(conn, list);
  return full;
}

export function deleteHistoryEntry(conn: string, id: string): HistoryEntry[] {
  const next = read(conn).filter(e => e.id !== id);
  write(conn, next);
  return next;
}

export function clearHistory(conn: string): void {
  try { localStorage.removeItem(keyFor(conn)); } catch { /* ignore */ }
}
