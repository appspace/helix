import { useState, CSSProperties } from 'react';
import { DARK, LIGHT } from './theme';
import type { ThemeName } from './theme';
import { TopBar } from './components/TopBar';
import { SchemaBrowser } from './components/SchemaBrowser';
import { QueryEditor } from './components/QueryEditor';
import { ResultsTable, type QueryResults } from './components/ResultsTable';
import { ConnectionManager, type ConnectionForm } from './components/ConnectionManager';

interface Tab {
  id: string;
  name: string;
  query: string;
  modified?: boolean;
}

const MOCK_SCHEMA = {
  tables: [
    {
      name: 'customers',
      rows: 124839,
      columns: [
        { name: 'id', type: 'int(11)', pk: true },
        { name: 'email', type: 'varchar(255)' },
        { name: 'name', type: 'varchar(120)' },
        { name: 'created_at', type: 'datetime' },
        { name: 'status', type: 'enum' },
      ],
    },
    {
      name: 'orders',
      rows: 891204,
      columns: [
        { name: 'id', type: 'int(11)', pk: true },
        { name: 'customer_id', type: 'int(11)' },
        { name: 'total', type: 'decimal(10,2)' },
        { name: 'status', type: 'varchar(32)' },
        { name: 'created_at', type: 'datetime' },
      ],
    },
    { name: 'products', rows: 4211, columns: [{ name: 'id', type: 'int(11)', pk: true }, { name: 'name', type: 'varchar(255)' }, { name: 'price', type: 'decimal(10,2)' }] },
    { name: 'order_items', rows: 2341098, columns: [{ name: 'id', type: 'int(11)', pk: true }, { name: 'order_id', type: 'int(11)' }, { name: 'product_id', type: 'int(11)' }, { name: 'qty', type: 'int(11)' }] },
    { name: 'sessions', rows: 44102, columns: [{ name: 'id', type: 'varchar(64)', pk: true }, { name: 'user_id', type: 'int(11)' }, { name: 'expires_at', type: 'datetime' }] },
  ],
  views: [],
  procedures: [],
  triggers: [],
};

const MOCK_RESULTS: QueryResults = {
  columns: ['id', 'email', 'name', 'created_at', 'status'],
  rows: [
    { id: 1, email: 'alice@example.com', name: 'Alice Johnson', created_at: '2024-01-15 09:23:11', status: 'active' },
    { id: 2, email: 'bob@example.com',   name: 'Bob Smith',    created_at: '2024-02-03 14:01:55', status: 'active' },
    { id: 3, email: 'carol@corp.io',     name: 'Carol White',  created_at: '2024-02-18 07:44:30', status: 'inactive' },
    { id: 4, email: 'dave@mail.net',     name: 'Dave Brown',   created_at: '2024-03-01 16:12:44', status: 'active' },
    { id: 5, email: 'eve@example.com',   name: 'Eve Davis',    created_at: '2024-03-11 11:05:02', status: 'suspended' },
    { id: 6, email: 'frank@corp.io',     name: null,           created_at: '2024-04-02 08:30:19', status: 'active' },
    { id: 7, email: 'grace@mail.net',    name: 'Grace Lee',    created_at: '2024-04-14 13:55:47', status: 'active' },
    { id: 8, email: 'henry@example.com', name: 'Henry Wilson', created_at: '2024-05-07 10:20:33', status: 'inactive' },
  ],
};

let tabCounter = 1;

export default function App() {
  const [themeName, setThemeName] = useState<ThemeName>('dark');
  const t = themeName === 'dark' ? DARK : LIGHT;

  const [connected, setConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connectionName, setConnectionName] = useState('Not connected');

  const [tabs, setTabs] = useState<Tab[]>([
    { id: '1', name: 'query_1.sql', query: 'SELECT *\nFROM customers\nWHERE status = \'active\'\nORDER BY created_at DESC\nLIMIT 50;' },
  ]);
  const [activeTab, setActiveTab] = useState('1');
  const [results, setResults] = useState<QueryResults | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [queryError] = useState<string | null>(null);
  const [execTime, setExecTime] = useState<number | null>(null);
  const [activeTable, setActiveTable] = useState<string | null>(null);
  const [activeSchema, setActiveSchema] = useState('app_production');

  const currentTab = tabs.find(tab => tab.id === activeTab)!;

  const handleConnect = (form: ConnectionForm) => {
    setIsConnecting(true);
    setConnectionError(null);
    setTimeout(() => {
      setIsConnecting(false);
      setConnected(true);
      setConnectionName(`${form.user}@${form.host}:${form.port}`);
    }, 1200);
  };

  const handleRun = () => {
    if (isRunning) { setIsRunning(false); return; }
    setIsRunning(true);
    setResults(null);
    const start = Date.now();
    setTimeout(() => {
      setIsRunning(false);
      setResults(MOCK_RESULTS);
      setExecTime(Date.now() - start);
    }, 800);
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
    setExecTime(null);
  };

  const toggleTheme = () => {
    const next: ThemeName = themeName === 'dark' ? 'light' : 'dark';
    setThemeName(next);
    document.documentElement.setAttribute('data-theme', next);
  };

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
        connectionStatus={connected ? 'connected' : 'disconnected'}
        themeName={themeName}
        onToggleTheme={toggleTheme}
        t={t}
      />

      <div style={bodyStyle}>
        <SchemaBrowser
          schema={MOCK_SCHEMA}
          activeTable={activeTable}
          onTableSelect={handleTableSelect}
          onSchemaChange={setActiveSchema}
          schemas={['app_production', 'app_staging', 'analytics', 'logs']}
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
