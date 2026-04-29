export interface SavedConnection {
  name: string;
  type?: 'mysql' | 'postgres' | 'mongodb';
  host: string;
  port: string;
  user: string;
  database: string;
  ssl: boolean;
  sslVerify?: boolean;
  // Whether the password is stored in the OS keychain (Electron only).
  savePassword?: boolean;
  // Optional MongoDB connection string (mongodb:// or mongodb+srv://).
  connectionString?: string;
}

const KEY = 'helix.connections';

function read(): Record<string, SavedConnection> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, SavedConnection> : {};
  } catch {
    return {};
  }
}

function write(all: Record<string, SavedConnection>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch { /* quota or disabled storage — ignore */ }
}

export function listSavedConnections(): SavedConnection[] {
  return Object.values(read()).sort((a, b) => a.name.localeCompare(b.name));
}

export function saveConnection(conn: SavedConnection): void {
  const name = conn.name.trim();
  if (!name) return;
  const all = read();
  all[name] = { ...conn, name };
  write(all);
}

export function deleteSavedConnection(name: string): void {
  const all = read();
  delete all[name];
  write(all);
}
