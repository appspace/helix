import { describe, it, expect, beforeEach } from 'vitest';
import { loadTabs, saveTabs, clearTabs, type PersistedTabState } from './tabPersistence';

class MemoryStorage {
  store = new Map<string, string>();
  getItem(k: string) { return this.store.get(k) ?? null; }
  setItem(k: string, v: string) { this.store.set(k, v); }
  removeItem(k: string) { this.store.delete(k); }
  clear() { this.store.clear(); }
  get length() { return this.store.size; }
  key(i: number) { return Array.from(this.store.keys())[i] ?? null; }
}

beforeEach(() => {
  // Vitest's default node env doesn't ship a localStorage; substitute one.
  // (The tabPersistence module reads the global lazily, so we can swap freely.)
  (globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage();
});

const sample: PersistedTabState = {
  tabs: [
    { id: '1', name: 'query_1.sql', query: 'SELECT 1' },
    { id: '2', name: 'users.sql', query: 'SELECT * FROM users', sourceTable: { schema: 'public', table: 'users' } },
  ],
  activeTabId: '2',
};

describe('tabPersistence', () => {
  it('round-trips a tab state through save and load', () => {
    saveTabs('conn-A', sample);
    expect(loadTabs('conn-A')).toEqual(sample);
  });

  it('returns null when nothing has been saved for the connection', () => {
    expect(loadTabs('never-saved')).toBeNull();
  });

  it('scopes state per connection — saving under one key does not leak into another', () => {
    saveTabs('conn-A', sample);
    expect(loadTabs('conn-B')).toBeNull();
  });

  it('returns null and skips persistence for an empty connection identifier', () => {
    saveTabs('', sample);
    expect(loadTabs('')).toBeNull();
  });

  it('returns null on malformed JSON without throwing', () => {
    localStorage.setItem('helix.tabs.broken', '{not json');
    expect(loadTabs('broken')).toBeNull();
  });

  it('returns null when the persisted shape is wrong (missing fields)', () => {
    localStorage.setItem('helix.tabs.bad', JSON.stringify({ tabs: 'oops', activeTabId: 1 }));
    expect(loadTabs('bad')).toBeNull();
  });

  it('drops malformed tab entries while keeping the well-formed ones', () => {
    localStorage.setItem('helix.tabs.mixed', JSON.stringify({
      tabs: [
        { id: '1', name: 'ok.sql', query: 'SELECT 1' },
        { id: 2, name: 'bad-id.sql', query: 'SELECT 2' }, // id wrong type
        { id: '3', query: 'SELECT 3' },                   // missing name
        null,
      ],
      activeTabId: '1',
    }));
    const restored = loadTabs('mixed');
    expect(restored?.tabs).toEqual([{ id: '1', name: 'ok.sql', query: 'SELECT 1' }]);
  });

  it('returns null when every tab entry is malformed (no usable state)', () => {
    localStorage.setItem('helix.tabs.empty', JSON.stringify({ tabs: [null, null], activeTabId: '1' }));
    expect(loadTabs('empty')).toBeNull();
  });

  it('clears persisted state for the connection', () => {
    saveTabs('conn-A', sample);
    clearTabs('conn-A');
    expect(loadTabs('conn-A')).toBeNull();
  });
});
