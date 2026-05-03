import { useState, useEffect, useCallback, useRef } from 'react';
import type { CSSProperties } from 'react';
import { DARK, LIGHT } from './theme';
import type { ThemeName } from './theme';
import { TopBar } from './components/TopBar';
import { SchemaBrowser } from './components/SchemaBrowser';
import { QueryEditor } from './components/QueryEditor';
import { ResultsTable, type QueryResults } from './components/ResultsTable';
import { ConnectionManager, type ConnectionForm } from './components/ConnectionManager';
import { api } from './api';
import type { SchemaData, QueryMode } from './api';
import { saveConnection } from './savedConnections';
import { electronAPI } from './electronAPI';
import { addHistoryEntry, listHistory, deleteHistoryEntry, clearHistory, type HistoryEntry } from './queryHistory';
import { listSavedQueries, saveQuery, deleteSavedQuery, renameSavedQuery, type SavedQuery } from './savedQueries';

interface Tab {
  id: string;
  name: string;
  query: string;
  modified?: boolean;
  results?: QueryResults | null;
  queryError?: string | null;
  execTime?: number | null;
  isRunning?: boolean;
}

const EMPTY_SCHEMA: SchemaData = { tables: [], views: [], procedures: [], triggers: [] };

const THEME_KEY = 'helix.theme';

function readStoredTheme(): ThemeName {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'dark';
  } catch {
    return 'dark';
  }
}

export default function App() {
  const [themeName, setThemeName] = useState<ThemeName>(readStoredTheme);
  const t = themeName === 'dark' ? DARK : LIGHT;

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', themeName);
    try { localStorage.setItem(THEME_KEY, themeName); } catch { /* quota or disabled storage */ }
  }, [themeName]);

  const [connected, setConnected] = useState(false);
  const [queryMode, setQueryMode] = useState<QueryMode>('sql');
  const [showConnectionModal, setShowConnectionModal] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connectionName, setConnectionName] = useState('Not connected');
  const [connectionHost, setConnectionHost] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([]);

  const [mcpWritesAllowed, setMcpWritesAllowed] = useState(false);
  const [mcpUrl, setMcpUrl] = useState<string>('');

  const [schemas, setSchemas] = useState<string[]>([]);
  const [activeSchema, setActiveSchema] = useState('');
  const [schemaData, setSchemaData] = useState<SchemaData>(EMPTY_SCHEMA);

  const [tabs, setTabs] = useState<Tab[]>([
    { id: '1', name: 'query_1.sql', query: '' },
  ]);
  const [activeTab, setActiveTab] = useState('1');
  const tabCounter = useRef(1);
  const [activeTable, setActiveTable] = useState<string | null>(null);

  const currentTab = tabs.find(tab => tab.id === activeTab)!;
  const results = currentTab?.results ?? null;
  const isRunning = currentTab?.isRunning ?? false;
  const queryError = currentTab?.queryError ?? null;
  const execTime = currentTab?.execTime ?? null;

  // Per-tab state updater. Targets a specific tab id (captured at call time)
  // so async query handlers write back to the originating tab even if the
  // user has switched in the meantime.
  const updateTab = useCallback((id: string, patch: Partial<Tab>) => {
    setTabs(ts => ts.map(tb => tb.id === id ? { ...tb, ...patch } : tb));
  }, []);

  const loadSchema = useCallback(async (schema: string) => {
    try {
      const data = await api.schema(schema);
      setSchemaData(data);
    } catch {
      setSchemaData(EMPTY_SCHEMA);
    }
  }, []);

  const handleSchemaChange = useCallback((schema: string) => {
    // Schema fetch is driven by the useEffect on activeSchema; only update state here.
    setActiveSchema(schema);
  }, []);

  const handleConnect = async (form: ConnectionForm) => {
    setIsConnecting(true);
    setConnectionError(null);
    try {
      const res = await api.connect(form);
      const { schemas: list } = await api.schemas();
      const initial = form.database && list.includes(form.database)
        ? form.database
        : list[0] ?? '';

      const friendly = form.name.trim();
      setConnectionName(friendly || res.connectionName);
      setConnectionHost(res.connectionName);
      setQueryMode(res.queryMode);
      setHistory(listHistory(res.connectionName));
      setSavedQueries(listSavedQueries(res.connectionName));
      setSchemas(list);
      setActiveSchema(initial);
      setConnected(true);
      setShowConnectionModal(false);

      // Persist non-secret fields so the user doesn't retype them next time.
      if (friendly) {
        saveConnection({
          name: friendly,
          type: form.type,
          host: form.host,
          port: form.port,
          user: form.user,
          database: form.database,
          ssl: form.ssl,
          sslVerify: form.sslVerify,
          savePassword: form.savePassword,
          ...(form.connectionString ? { connectionString: form.connectionString } : {}),
        });
        if (electronAPI) {
          if (form.savePassword && form.password) {
            electronAPI.passwords.save(friendly, form.password).catch(err => {
              console.error('Failed to save password:', err);
            });
          } else {
            electronAPI.passwords.delete(friendly).catch(() => {});
          }
        }
      }
    } catch (err) {
      setConnectionError(err instanceof Error ? err.message : String(err));
      try { await api.disconnect(); } catch { /* ignore */ }
    } finally {
      setIsConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    try { await api.disconnect(); } catch { /* ignore */ }
    setConnected(false);
    setQueryMode('sql');
    setShowConnectionModal(true);
    setConnectionName('Not connected');
    setConnectionHost(null);
    setHistory([]);
    setSavedQueries([]);
    setConnectionError(null);
    setSchemas([]);
    setActiveSchema('');
    setSchemaData(EMPTY_SCHEMA);
    tabCounter.current = 1;
    setTabs([{ id: '1', name: 'query_1.sql', query: '' }]);
    setActiveTab('1');
    setActiveTable(null);
  };

  const handleDropTable = async (schema: string, table: string) => {
    await api.dropTable(schema, table);
    if (activeTable === table) setActiveTable(null);
    updateTab(activeTab, { results: null, queryError: null });
    await loadSchema(schema);
  };

  const handleInsertRow = async (
    table: string,
    values: Record<string, string | number | boolean | null>,
  ) => {
    const targetTab = activeTab;
    await api.insertRow(activeSchema, table, values);
    // Re-run the current query so the grid reflects the new row (if it matches WHERE/ORDER/LIMIT).
    const sql = currentTab?.query?.trim();
    if (sql) {
      try {
        const res = await api.query(sql, activeSchema);
        updateTab(targetTab, {
          results: { columns: res.columns, columnMeta: res.columnMeta, rows: res.rows },
          execTime: res.executionTime,
        });
      } catch { /* leave prior results visible */ }
    }
    // Refresh schema row counts in the sidebar.
    if (activeSchema) loadSchema(activeSchema);
  };

  const handleUpdateCell = async (
    row: Record<string, string | number | boolean | null>,
    target: { table: string; where: { column: string; value: string | number | boolean | null }[]; column: string; value: string | number | boolean | null },
  ) => {
    const targetTab = activeTab;
    await api.updateCell(activeSchema, target.table, target.where, target.column, target.value);
    setTabs(ts => ts.map(tb => {
      if (tb.id !== targetTab || !tb.results) return tb;
      const meta = tb.results.columnMeta?.find(m => m.orgTable === target.table && m.orgName === target.column);
      const key = meta?.name ?? target.column;
      return { ...tb, results: { ...tb.results, rows: tb.results.rows.map(r => r === row ? { ...r, [key]: target.value } : r) } };
    }));
  };

  const handleDeleteRow = async (
    row: Record<string, string | number | boolean | null>,
    target: { table: string; where: { column: string; value: string | number | boolean | null }[] },
  ) => {
    const targetTab = activeTab;
    const result = await api.deleteRow(activeSchema, target.table, target.where);
    if (result.affectedRows === 0) {
      throw new Error('No rows were deleted (row may have already been removed).');
    }
    setTabs(ts => ts.map(tb => tb.id === targetTab && tb.results
      ? { ...tb, results: { ...tb.results, rows: tb.results.rows.filter(r => r !== row) } }
      : tb));
  };

  const handleRun = async () => {
    if (isRunning) return;
    const text = currentTab?.query?.trim();
    if (!text) return;
    const targetTab = activeTab;

    let mqlPayload: unknown = null;
    if (queryMode === 'mql') {
      try {
        mqlPayload = JSON.parse(text);
      } catch (err) {
        // Surface the error so callers that bypass QueryEditor.handleRunClick still see it.
        updateTab(targetTab, { queryError: err instanceof Error ? err.message : String(err) });
        return;
      }
      if (typeof mqlPayload !== 'object' || mqlPayload === null || Array.isArray(mqlPayload)) {
        updateTab(targetTab, { queryError: 'MQL request must be a JSON object (e.g. { "collection": "...", "operation": "find" }).' });
        return;
      }
    }

    updateTab(targetTab, { isRunning: true, results: null, queryError: null, execTime: null });

    const started = Date.now();
    try {
      const res = queryMode === 'mql'
        ? await api.queryMql(mqlPayload, activeSchema)
        : await api.query(text, activeSchema);
      updateTab(targetTab, {
        results: { columns: res.columns, columnMeta: res.columnMeta, rows: res.rows },
        execTime: res.executionTime,
      });
      if (connectionHost) {
        const entry = addHistoryEntry(connectionHost, {
          sql: text, schema: activeSchema, executedAt: started,
          durationMs: res.executionTime, status: 'ok', rowCount: res.rows.length,
        });
        if (entry) setHistory(prev => [entry, ...prev].slice(0, 100));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateTab(targetTab, { queryError: message });
      if (connectionHost) {
        const entry = addHistoryEntry(connectionHost, {
          sql: text, schema: activeSchema, executedAt: started,
          durationMs: Date.now() - started, status: 'error', error: message,
        });
        if (entry) setHistory(prev => [entry, ...prev].slice(0, 100));
      }
    } finally {
      updateTab(targetTab, { isRunning: false });
    }
  };

  const handleReopenHistory = (entry: HistoryEntry) => {
    addTab(`history_${entry.id.slice(0, 8)}.sql`, entry.sql);
  };

  const handleDeleteHistoryEntry = (id: string) => {
    if (!connectionHost) return;
    setHistory(deleteHistoryEntry(connectionHost, id));
  };

  const handleClearHistory = () => {
    if (!connectionHost) return;
    clearHistory(connectionHost);
    setHistory([]);
  };

  const handleSaveQuery = (name: string, sql: string, schema: string) => {
    if (!connectionHost) return;
    const entry = saveQuery(connectionHost, { name, sql, schema });
    setSavedQueries(prev => [entry, ...prev]);
  };

  const handleDeleteSavedQuery = (id: string) => {
    if (!connectionHost) return;
    setSavedQueries(deleteSavedQuery(connectionHost, id));
  };

  const handleRenameSavedQuery = (id: string, name: string) => {
    if (!connectionHost) return;
    setSavedQueries(renameSavedQuery(connectionHost, id, name));
  };

  const handleReopenSavedQuery = (query: SavedQuery) => {
    addTab(`${query.name}.sql`, query.sql);
  };

  const handleQueryChange = (val: string) => {
    setTabs(ts => ts.map(tab => tab.id === activeTab ? { ...tab, query: val, modified: true } : tab));
  };

  const addTab = (name: string, query: string) => {
    tabCounter.current++;
    const id = String(tabCounter.current);
    setTabs(ts => [...ts, { id, name, query }]);
    setActiveTab(id);
    return id;
  };

  const handleNewTab = () => addTab(`query_${tabCounter.current + 1}.sql`, '');

  const handleCloseTab = (id: string) => {
    setTabs(ts => {
      const next = ts.filter(tab => tab.id !== id);
      if (activeTab === id && next.length > 0) setActiveTab(next[next.length - 1].id);
      return next.length > 0 ? next : ts;
    });
  };

  const handleTableSelect = (name: string) => {
    setActiveTable(name);
    const tabName = queryMode === 'mql' ? `${name}.json` : `${name}.sql`;
    const existing = tabs.find(tb => tb.name === tabName);
    if (existing) {
      setActiveTab(existing.id);
      return;
    }
    if (queryMode === 'mql') {
      const body = JSON.stringify({ collection: name, operation: 'find', filter: {}, limit: 100 }, null, 2);
      addTab(tabName, body);
    } else {
      addTab(tabName, `SELECT *\nFROM \`${name}\`\nLIMIT 100;`);
    }
  };

  const switchTab = (id: string) => {
    setActiveTab(id);
  };

  const toggleTheme = () => {
    setThemeName(themeName === 'dark' ? 'light' : 'dark');
  };

  // Reload schema when switching schemas from the dropdown
  useEffect(() => {
    if (connected && activeSchema) loadSchema(activeSchema);
  }, [activeSchema, connected, loadSchema]);

  // Sync MCP status on mount and whenever connection state changes (covers page refresh).
  useEffect(() => {
    let cancelled = false;
    api.mcpStatus()
      .then(s => {
        if (cancelled) return;
        setMcpWritesAllowed(s.writesAllowed);
        setMcpUrl(s.mcpUrl);
      })
      .catch(() => { /* server unreachable — leave defaults */ });
    return () => { cancelled = true; };
  }, [connected]);

  const handleToggleMcpWrites = async (enabled: boolean) => {
    const res = await api.setMcpWrites(enabled);
    setMcpWritesAllowed(res.writesAllowed);
  };

  const appStyle: CSSProperties = {
    display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden',
    background: t.bgBase,
  };
  const bodyStyle: CSSProperties = { display: 'flex', flex: 1, overflow: 'hidden' };
  const mainStyle: CSSProperties = { display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' };

  const handleOpenConnection = useCallback(() => setShowConnectionModal(true), []);

  return (
    <div style={appStyle}>
      <TopBar
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={switchTab}
        onNewTab={handleNewTab}
        onCloseTab={handleCloseTab}
        connectionName={connectionName}
        connectionHost={connectionHost}
        connectionStatus={connected ? 'connected' : 'disconnected'}
        onDisconnect={handleDisconnect}
        onOpenConnection={connected ? undefined : handleOpenConnection}
        mcpWritesAllowed={mcpWritesAllowed}
        mcpUrl={mcpUrl}
        onToggleMcpWrites={handleToggleMcpWrites}
        themeName={themeName}
        onToggleTheme={toggleTheme}
        t={t}
      />

      <div style={bodyStyle}>
        <SchemaBrowser
          schema={schemaData}
          activeTable={activeTable}
          onTableSelect={handleTableSelect}
          onSchemaChange={handleSchemaChange}
          schemas={schemas}
          activeSchema={activeSchema}
          onDropTable={handleDropTable}
          t={t}
        />

        <div style={mainStyle}>
          <div style={{ flex: '0 0 240px', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <QueryEditor
              value={currentTab?.query ?? ''}
              onChange={handleQueryChange}
              onRun={handleRun}
              isRunning={isRunning}
              queryMode={queryMode}
              activeSchema={activeSchema}
              schemaData={schemaData}
              runtimeError={queryError}
              history={history}
              onReopenHistory={handleReopenHistory}
              onDeleteHistoryEntry={handleDeleteHistoryEntry}
              onClearHistory={handleClearHistory}
              savedQueries={savedQueries}
              onSaveQuery={handleSaveQuery}
              onDeleteSavedQuery={handleDeleteSavedQuery}
              onRenameSavedQuery={handleRenameSavedQuery}
              onReopenSavedQuery={handleReopenSavedQuery}
              t={t}
            />
          </div>
          <ResultsTable
            results={results}
            isRunning={isRunning}
            error={queryError}
            executionTime={execTime}
            activeSchema={activeSchema}
            schemaData={schemaData}
            onDeleteRow={handleDeleteRow}
            onUpdateCell={handleUpdateCell}
            onInsertRow={handleInsertRow}
            t={t}
          />
        </div>
      </div>

      {!connected && showConnectionModal && (
        <ConnectionManager
          onConnect={handleConnect}
          isConnecting={isConnecting}
          error={connectionError}
          t={t}
        />
      )}
    </div>
  );
}
