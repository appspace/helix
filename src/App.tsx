import { useState, useEffect, useCallback, CSSProperties } from 'react';
import { DARK, LIGHT } from './theme';
import type { ThemeName } from './theme';
import { TopBar } from './components/TopBar';
import { SchemaBrowser } from './components/SchemaBrowser';
import { QueryEditor } from './components/QueryEditor';
import { ResultsTable, type QueryResults } from './components/ResultsTable';
import { ConnectionManager, type ConnectionForm } from './components/ConnectionManager';
import { api } from './api';
import type { SchemaData } from './api';

interface Tab {
  id: string;
  name: string;
  query: string;
  modified?: boolean;
}

const EMPTY_SCHEMA: SchemaData = { tables: [], views: [], procedures: [], triggers: [] };

let tabCounter = 1;

export default function App() {
  const [themeName, setThemeName] = useState<ThemeName>('dark');
  const t = themeName === 'dark' ? DARK : LIGHT;

  const [connected, setConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connectionName, setConnectionName] = useState('Not connected');
  const [connectionHost, setConnectionHost] = useState<string | null>(null);

  const [schemas, setSchemas] = useState<string[]>([]);
  const [activeSchema, setActiveSchema] = useState('');
  const [schemaData, setSchemaData] = useState<SchemaData>(EMPTY_SCHEMA);

  const [tabs, setTabs] = useState<Tab[]>([
    { id: '1', name: 'query_1.sql', query: '' },
  ]);
  const [activeTab, setActiveTab] = useState('1');
  const [results, setResults] = useState<QueryResults | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [execTime, setExecTime] = useState<number | null>(null);
  const [activeTable, setActiveTable] = useState<string | null>(null);

  const currentTab = tabs.find(tab => tab.id === activeTab)!;

  const loadSchema = useCallback(async (schema: string) => {
    try {
      const data = await api.schema(schema);
      setSchemaData(data);
    } catch {
      setSchemaData(EMPTY_SCHEMA);
    }
  }, []);

  const handleSchemaChange = useCallback((schema: string) => {
    setActiveSchema(schema);
    loadSchema(schema);
  }, [loadSchema]);

  const handleConnect = async (form: ConnectionForm) => {
    setIsConnecting(true);
    setConnectionError(null);
    try {
      const res = await api.connect(form);
      setConnected(true);
      const friendly = form.name.trim();
      setConnectionName(friendly || res.connectionName);
      setConnectionHost(res.connectionName);

      const { schemas: list } = await api.schemas();
      const initial = form.database && list.includes(form.database)
        ? form.database
        : list[0] ?? '';
      setSchemas(list);
      setActiveSchema(initial);
      if (initial) await loadSchema(initial);
    } catch (err) {
      setConnectionError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    try { await api.disconnect(); } catch { /* ignore */ }
    setConnected(false);
    setConnectionName('Not connected');
    setConnectionHost(null);
    setConnectionError(null);
    setSchemas([]);
    setActiveSchema('');
    setSchemaData(EMPTY_SCHEMA);
    setResults(null);
    setQueryError(null);
    setExecTime(null);
    setActiveTable(null);
  };

  const handleDeleteRow = async (
    row: Record<string, string | number | null>,
    target: { table: string; where: { column: string; value: string | number | null }[] },
  ) => {
    const result = await api.deleteRow(activeSchema, target.table, target.where);
    if (result.affectedRows === 0) {
      throw new Error('No rows were deleted (row may have already been removed).');
    }
    setResults(prev => prev ? { ...prev, rows: prev.rows.filter(r => r !== row) } : prev);
  };

  const handleRun = async () => {
    if (isRunning) return;
    const sql = currentTab?.query?.trim();
    if (!sql) return;

    setIsRunning(true);
    setResults(null);
    setQueryError(null);
    setExecTime(null);

    try {
      const res = await api.query(sql, activeSchema);
      setResults({ columns: res.columns, columnMeta: res.columnMeta, rows: res.rows });
      setExecTime(res.executionTime);
    } catch (err) {
      setQueryError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRunning(false);
    }
  };

  const handleQueryChange = (val: string) => {
    setTabs(ts => ts.map(tab => tab.id === activeTab ? { ...tab, query: val, modified: true } : tab));
  };

  const addTab = (name: string, query: string) => {
    tabCounter++;
    const id = String(tabCounter);
    setTabs(ts => [...ts, { id, name, query }]);
    setActiveTab(id);
    setResults(null);
    setQueryError(null);
    setExecTime(null);
    return id;
  };

  const handleNewTab = () => addTab(`query_${tabCounter + 1}.sql`, '');

  const handleCloseTab = (id: string) => {
    setTabs(ts => {
      const next = ts.filter(tab => tab.id !== id);
      if (activeTab === id && next.length > 0) setActiveTab(next[next.length - 1].id);
      return next.length > 0 ? next : ts;
    });
  };

  const handleTableSelect = (name: string) => {
    setActiveTable(name);
    addTab(`${name}.sql`, `SELECT *\nFROM \`${name}\`\nLIMIT 100;`);
  };

  const switchTab = (id: string) => {
    setActiveTab(id);
    setResults(null);
    setQueryError(null);
    setExecTime(null);
  };

  const toggleTheme = () => {
    const next: ThemeName = themeName === 'dark' ? 'light' : 'dark';
    setThemeName(next);
    document.documentElement.setAttribute('data-theme', next);
  };

  // Reload schema when switching schemas from the dropdown
  useEffect(() => {
    if (connected && activeSchema) loadSchema(activeSchema);
  }, [activeSchema, connected, loadSchema]);

  const appStyle: CSSProperties = {
    display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden',
    background: t.bgBase,
  };
  const bodyStyle: CSSProperties = { display: 'flex', flex: 1, overflow: 'hidden' };
  const mainStyle: CSSProperties = { display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' };

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
          t={t}
        />

        <div style={mainStyle}>
          <div style={{ flex: '0 0 240px', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <QueryEditor
              value={currentTab?.query ?? ''}
              onChange={handleQueryChange}
              onRun={handleRun}
              isRunning={isRunning}
              activeSchema={activeSchema}
              t={t}
            />
          </div>
          <ResultsTable
            results={results}
            isRunning={isRunning}
            error={queryError}
            executionTime={execTime}
            onDeleteRow={handleDeleteRow}
            t={t}
          />
        </div>
      </div>

      {!connected && (
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
