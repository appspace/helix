// Tab state is persisted per connection so a returning user lands back on
// the same set of editor tabs they had open. Result data is intentionally
// not persisted — rerunning is fast and stale rows on disk are a privacy
// + UX hazard. See #153.

export interface PersistedTab {
  id: string;
  name: string;
  query: string;
  sourceTable?: { schema: string; table: string };
}

export interface PersistedTabState {
  tabs: PersistedTab[];
  activeTabId: string;
}

function keyFor(conn: string): string {
  return `helix.tabs.${conn}`;
}

export function loadTabs(conn: string): PersistedTabState | null {
  if (!conn) return null;
  try {
    const raw = localStorage.getItem(keyFor(conn));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Array.isArray((parsed as PersistedTabState).tabs) ||
      typeof (parsed as PersistedTabState).activeTabId !== 'string'
    ) return null;
    const state = parsed as PersistedTabState;
    // Drop entries that don't match the expected shape — defensively skip
    // anything malformed rather than blowing up restoration entirely.
    const tabs = state.tabs.filter(
      t => t && typeof t.id === 'string' && typeof t.name === 'string' && typeof t.query === 'string',
    );
    if (tabs.length === 0) return null;
    return { tabs, activeTabId: state.activeTabId };
  } catch {
    return null;
  }
}

export function saveTabs(conn: string, state: PersistedTabState): void {
  if (!conn) return;
  try {
    localStorage.setItem(keyFor(conn), JSON.stringify(state));
  } catch { /* quota or disabled storage — ignore */ }
}

export function clearTabs(conn: string): void {
  if (!conn) return;
  try { localStorage.removeItem(keyFor(conn)); } catch { /* ignore */ }
}
