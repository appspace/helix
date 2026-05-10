import { useState, useEffect } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { Theme } from '../theme';
import { api } from '../api';
import { listSavedConnections, deleteSavedConnection, type SavedConnection } from '../savedConnections';
import { electronAPI } from '../electronAPI';

export type DbType = 'mysql' | 'postgres' | 'mongodb';

export interface ConnectionForm {
  name: string;
  type: DbType;
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
  ssl: boolean;
  sslVerify: boolean;
  // Only meaningful in Electron — when true, the password is persisted via
  // safeStorage and reloaded the next time this connection is opened.
  savePassword: boolean;
  // Only meaningful when type === 'mongodb' AND mongoMode === 'uri'.
  connectionString?: string;
  // UI state: which input mode the mongodb form is in. Persisted alongside
  // the connection itself (derived on load: presence of connectionString).
  mongoMode?: 'fields' | 'uri';
}

interface ConnectionManagerProps {
  onConnect: (form: ConnectionForm) => void;
  isConnecting: boolean;
  error: string | null;
  t: Theme;
}

interface DbTypeMeta {
  id: DbType;
  name: string;
  badge: 'SQL' | 'NoSQL';
  version: string;
  desc: string;
  defaultPort: string;
  defaultUser: string;
  icon: (color: string) => ReactNode;
}

const DB_TYPES: DbTypeMeta[] = [
  {
    id: 'mysql',
    name: 'MySQL',
    badge: 'SQL',
    version: '5.7 – 8.x',
    desc: 'Popular open source relational database',
    defaultPort: '3306',
    defaultUser: 'root',
    icon: (color) => (
      <svg width="22" height="22" viewBox="0 0 40 40" fill="none">
        <ellipse cx="20" cy="12" rx="14" ry="5" stroke={color} strokeWidth="2.5" fill="none"/>
        <path d="M6 12v16c0 2.76 6.27 5 14 5s14-2.24 14-5V12" stroke={color} strokeWidth="2.5" fill="none"/>
        <path d="M6 20c0 2.76 6.27 5 14 5s14-2.24 14-5" stroke={color} strokeWidth="1.5" fill="none" opacity="0.5"/>
      </svg>
    ),
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    badge: 'SQL',
    version: '12 – 16',
    desc: 'Advanced relational database with powerful extensions',
    defaultPort: '5432',
    defaultUser: 'postgres',
    icon: (color) => (
      <svg width="22" height="22" viewBox="0 0 40 40" fill="none">
        <ellipse cx="20" cy="12" rx="14" ry="5" stroke={color} strokeWidth="2.5" fill="none"/>
        <path d="M6 12v16c0 2.76 6.27 5 14 5s14-2.24 14-5V12" stroke={color} strokeWidth="2.5" fill="none"/>
        <path d="M6 20c0 2.76 6.27 5 14 5s14-2.24 14-5" stroke={color} strokeWidth="1.5" fill="none" opacity="0.5"/>
        <path d="M27 8 C32 4, 37 10, 33 16" stroke={color} strokeWidth="1.5" strokeLinecap="round" fill="none"/>
      </svg>
    ),
  },
  {
    id: 'mongodb',
    name: 'MongoDB',
    badge: 'NoSQL',
    version: '4.4 – 7.x',
    desc: 'Flexible document database for modern applications',
    defaultPort: '27017',
    defaultUser: '',
    icon: (color) => (
      <svg width="22" height="22" viewBox="0 0 40 40" fill="none">
        <path d="M20 4 C20 4, 28 14, 28 22 C28 30, 24 36, 20 36 C16 36, 12 30, 12 22 C12 14, 20 4, 20 4Z" stroke={color} strokeWidth="2.5" fill="none"/>
        <line x1="20" y1="30" x2="20" y2="38" stroke={color} strokeWidth="1.5" strokeLinecap="round"/>
      </svg>
    ),
  },
];

const dbMeta = (type: DbType): DbTypeMeta => DB_TYPES.find(d => d.id === type) ?? DB_TYPES[0];
const defaultPort = (type: DbType): string => dbMeta(type).defaultPort;

// Mirrors `connectionLabel` in `server/src/routes/connect.ts`: rewrites
// `mongodb+srv://` so WHATWG URL populates host/username, and prefers
// `hostname` over `host` so we never leak an explicit port. Returns just the
// host portion (no `user@`) for the saved-list subtitle. Falls back to a
// neutral placeholder rather than the raw URI so a malformed entry — or one
// we can't parse — never displays an embedded password.
const hostFromConnectionString = (uri: string): string => {
  try {
    const normalized = uri.replace(/^mongodb\+srv:\/\//, 'mongodb://');
    const url = new URL(normalized);
    return url.hostname || '<connectionString>';
  } catch {
    return '<connectionString>';
  }
};

const formFromSaved = (entry: SavedConnection): ConnectionForm => {
  const type: DbType = entry.type ?? 'mysql';
  const mongoMode: 'fields' | 'uri' = type === 'mongodb' && entry.connectionString ? 'uri' : 'fields';
  return {
    name: entry.name,
    type,
    host: entry.host ?? '',
    port: entry.port ?? '',
    user: entry.user ?? '',
    password: '',
    database: entry.database ?? '',
    ssl: entry.ssl ?? false,
    sslVerify: entry.sslVerify ?? false,
    savePassword: entry.savePassword ?? false,
    connectionString: entry.connectionString,
    mongoMode,
  };
};

const freshFormFor = (type: DbType): ConnectionForm => {
  const d = dbMeta(type);
  return {
    name: `Local ${d.name}`,
    type,
    host: import.meta.env['VITE_DEFAULT_HOST'] ?? 'localhost',
    port: import.meta.env['VITE_DEFAULT_PORT'] ?? d.defaultPort,
    user: import.meta.env['VITE_DEFAULT_USER'] ?? d.defaultUser,
    password: '',
    database: '',
    ssl: false,
    sslVerify: true,
    savePassword: false,
    mongoMode: type === 'mongodb' ? 'fields' : undefined,
  };
};

export function ConnectionManager({ onConnect, isConnecting, error, t }: ConnectionManagerProps) {
  const [saved, setSaved] = useState<SavedConnection[]>(() => listSavedConnections());
  const [step, setStep] = useState<'pick' | 'form'>('pick');
  const [form, setForm] = useState<ConnectionForm>(() => freshFormFor('mysql'));
  const [appliedSaved, setAppliedSaved] = useState<string>('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: true } | { ok: false; error: string } | null>(null);
  const [canSavePassword, setCanSavePassword] = useState(false);

  useEffect(() => {
    let cancelled = false;
    electronAPI?.passwords.available().then(ok => { if (!cancelled) setCanSavePassword(ok); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const meta = dbMeta(form.type);
  const isMongoUri = form.type === 'mongodb' && form.mongoMode === 'uri';

  const buildSubmitForm = (): ConnectionForm => {
    if (isMongoUri) return form;
    // Strip connectionString in fields mode so it can't slip through if a stale
    // value lingered in form state (e.g. after switching modes/types).
    const { connectionString: _cs, ...rest } = form;
    return { ...rest };
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      await api.testConnection(buildSubmitForm());
      setTestResult({ ok: true });
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  };

  const set = <K extends keyof ConnectionForm>(k: K, v: ConnectionForm[K]) => {
    setForm(p => ({ ...p, [k]: v }));
    setTestResult(null);
  };

  const setMongoMode = (mode: 'fields' | 'uri') => {
    setForm(p => ({ ...p, mongoMode: mode }));
    setTestResult(null);
  };

  const pickFreshDb = (type: DbType) => {
    setForm(freshFormFor(type));
    setAppliedSaved('');
    setTestResult(null);
    setStep('form');
  };

  const applySaved = (entry: SavedConnection) => {
    setForm(formFromSaved(entry));
    setAppliedSaved(entry.name);
    setTestResult(null);
    if (entry.savePassword && electronAPI) {
      electronAPI.passwords.load(entry.name).then(pw => {
        if (pw === null) return;
        setForm(p => p.name === entry.name && p.password === '' ? { ...p, password: pw } : p);
      }).catch(() => {});
    }
    setStep('form');
  };

  const removeSaved = (name: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    deleteSavedConnection(name);
    electronAPI?.passwords.delete(name).catch(() => {});
    const next = listSavedConnections();
    setSaved(next);
    if (appliedSaved === name) setAppliedSaved('');
  };

  const s = {
    overlay: { position: 'fixed', inset: 0, background: t.bgBase, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', zIndex: 300 } as CSSProperties,
    modal: { width: 500, maxWidth: '92vw', background: t.bgElevated, border: `1px solid ${t.border}`, borderRadius: 12, overflow: 'hidden', boxShadow: t.shadowModal } as CSSProperties,
    header: { padding: '18px 22px', borderBottom: `1px solid ${t.border}`, display: 'flex', alignItems: 'center', gap: 12, background: t.bgSurface } as CSSProperties,
    title: { fontSize: 15, fontWeight: 600, color: t.textPrimary, fontFamily: '"Space Grotesk", sans-serif' } as CSSProperties,
    subtitle: { fontSize: 11, color: t.textMuted, marginTop: 2 } as CSSProperties,
    body: { padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 10 } as CSSProperties,
    label: { fontSize: 10, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: t.textMuted, fontFamily: '"IBM Plex Sans", sans-serif' } as CSSProperties,
    field: { display: 'flex', flexDirection: 'column', gap: 4 } as CSSProperties,
    input: { height: 32, background: t.bgInput, border: `1px solid ${t.border}`, borderRadius: 5, padding: '0 10px', fontSize: 13, color: t.textPrimary, outline: 'none', width: '100%', fontFamily: 'inherit', boxSizing: 'border-box' } as CSSProperties,
    row: { display: 'flex', gap: 10 } as CSSProperties,
    footer: { padding: '12px 22px', borderTop: `1px solid ${t.border}`, background: t.bgSurface, display: 'flex', alignItems: 'center', gap: 10 } as CSSProperties,
    testBtn: { height: 32, padding: '0 14px', background: 'transparent', border: `1px solid ${t.border}`, borderRadius: 5, fontSize: 12, color: t.textSecondary, cursor: 'pointer', fontFamily: 'inherit' } as CSSProperties,
    connectBtn: { height: 32, padding: '0 18px', background: t.accent, border: 'none', borderRadius: 5, fontSize: 13, fontWeight: 600, color: t.textInverse, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'inherit' } as CSSProperties,
    backBtn: { background: 'none', border: 'none', cursor: 'pointer', color: t.textMuted, display: 'flex', alignItems: 'center', padding: '2px 4px', borderRadius: 4 } as CSSProperties,
    dbCard: { display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px', background: t.bgElevated, border: `1px solid ${t.border}`, borderRadius: 8, cursor: 'pointer', transition: 'border-color 120ms ease' } as CSSProperties,
    dbCardIcon: { width: 40, height: 40, background: t.accentMuted, border: `1px solid ${t.borderAccent}`, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 } as CSSProperties,
    badge: { fontSize: 9, fontWeight: 600, color: t.accent, background: t.accentMuted, border: `1px solid ${t.borderAccent}`, padding: '1px 6px', borderRadius: 9999, letterSpacing: '0.04em' } as CSSProperties,
    sectionLabel: { fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: t.textMuted, padding: '0 4px' } as CSSProperties,
    errorBanner: { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', background: t.colorErrorBg, border: `1px solid ${t.colorErrorBorder}`, borderRadius: 6, fontSize: 12, color: t.colorError, fontFamily: 'monospace' } as CSSProperties,
  };

  // ─────────────────────────────────────────────────────────
  // Step 1 — Picker (saved connections + DB type cards)
  // ─────────────────────────────────────────────────────────
  if (step === 'pick') {
    return (
      <div style={s.overlay}>
        <div style={s.modal}>
          <div style={s.header}>
            <svg width="20" height="20" viewBox="0 0 40 40" fill="none">
              <path d="M6 6 C6 6, 20 2, 20 20 C20 38, 6 34, 6 34" stroke={t.accent} strokeWidth="2.5" strokeLinecap="round"/>
              <path d="M16 6 C16 6, 30 2, 30 20 C30 38, 16 34, 16 34" stroke={t.accent} strokeWidth="2.5" strokeLinecap="round" opacity="0.5"/>
              <circle cx="6"  cy="6"  r="2.5" fill={t.accent}/>
              <circle cx="20" cy="20" r="2.5" fill={t.accent}/>
              <circle cx="6"  cy="34" r="2.5" fill={t.accent}/>
            </svg>
            <div>
              <div style={s.title}>Connect to a database</div>
              <div style={s.subtitle}>
                {saved.length > 0 ? 'Pick a saved connection or start fresh' : 'Select the database type to get started'}
              </div>
            </div>
          </div>

          <div style={{ padding: '16px 22px 20px', display: 'flex', flexDirection: 'column', gap: 14, maxHeight: '70vh', overflowY: 'auto' }}>
            {saved.length > 0 && (
              <>
                <div style={s.sectionLabel}>Saved connections</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {saved.map(entry => {
                    const m = dbMeta(entry.type ?? 'mysql');
                    const subtitle = (entry.user || entry.host || entry.port)
                      ? `${entry.user}@${entry.host}:${entry.port}`
                      : entry.connectionString
                        ? hostFromConnectionString(entry.connectionString)
                        : '';
                    return (
                      <SavedRow
                        key={entry.name}
                        name={entry.name}
                        subtitle={subtitle}
                        meta={m}
                        ssl={!!entry.ssl}
                        database={entry.database}
                        onClick={() => applySaved(entry)}
                        onForget={(e) => removeSaved(entry.name, e)}
                        t={t}
                      />
                    );
                  })}
                </div>
                <div style={{ ...s.sectionLabel, marginTop: 6 }}>Or start fresh</div>
              </>
            )}

            {DB_TYPES.map(d => (
              <DbCard key={d.id} meta={d} onClick={() => pickFreshDb(d.id)} t={t} s={s}/>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────
  // Step 2 — Connection form
  // ─────────────────────────────────────────────────────────
  return (
    <div style={s.overlay}>
      <div style={s.modal}>
        <div style={s.header}>
          <button type="button" style={s.backBtn} onClick={() => setStep('pick')} title="Back">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
          </button>
          <div style={{ width: 32, height: 32, background: t.accentMuted, border: `1px solid ${t.borderAccent}`, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {meta.icon(t.accent)}
          </div>
          <div>
            <div style={s.title}>{appliedSaved || `New ${meta.name} connection`}</div>
            <div style={s.subtitle}>{meta.badge} · port {meta.defaultPort}</div>
          </div>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (isConnecting) return;
            onConnect(buildSubmitForm());
          }}
          autoComplete="on"
        >
          <div style={s.body}>
            <div style={s.field}>
              <label style={s.label}>Connection name</label>
              <input
                style={s.input}
                name="connection-name"
                autoComplete="off"
                value={form.name}
                onChange={e => set('name', e.target.value)}
                placeholder="My Database"
              />
            </div>

            {form.type === 'mongodb' && (
              <div style={s.field}>
                <label style={s.label}>Input mode</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  {(['fields', 'uri'] as const).map(mode => {
                    const active = form.mongoMode === mode;
                    return (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setMongoMode(mode)}
                        style={{
                          height: 30, padding: '0 14px',
                          background: active ? t.accent : t.bgInput,
                          border: `1px solid ${active ? t.accent : t.border}`,
                          borderRadius: 5, fontSize: 12, fontWeight: active ? 600 : 400,
                          color: active ? t.textInverse : t.textSecondary,
                          cursor: 'pointer', fontFamily: 'inherit',
                        }}
                      >
                        {mode === 'fields' ? 'Fields' : 'Connection string'}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {isMongoUri ? (
              <div style={s.field}>
                <label style={s.label}>Connection string</label>
                <textarea
                  style={{ ...s.input, height: 72, padding: '8px 10px', fontFamily: 'monospace', resize: 'vertical' }}
                  name="connection-string"
                  autoComplete="off"
                  value={form.connectionString ?? ''}
                  onChange={e => set('connectionString', e.target.value)}
                  placeholder="mongodb://user:pass@host:27017/?authSource=admin"
                />
              </div>
            ) : (
              <>
                <div style={s.row}>
                  <div style={{ ...s.field, flex: 1 }}>
                    <label style={s.label}>Host</label>
                    <input
                      style={s.input}
                      name="host"
                      autoComplete="off"
                      value={form.host}
                      onChange={e => set('host', e.target.value)}
                      placeholder="localhost"
                    />
                  </div>
                  <div style={{ ...s.field, width: 90 }}>
                    <label style={s.label}>Port</label>
                    <input
                      style={{ ...s.input, fontFamily: '"JetBrains Mono", monospace', fontSize: 12 }}
                      name="port"
                      autoComplete="off"
                      value={form.port}
                      onChange={e => set('port', e.target.value)}
                      placeholder={meta.defaultPort}
                    />
                  </div>
                </div>

                <div style={s.row}>
                  <div style={{ ...s.field, flex: 1 }}>
                    <label style={s.label}>Username</label>
                    <input
                      style={s.input}
                      name="username"
                      autoComplete="username"
                      value={form.user}
                      onChange={e => set('user', e.target.value)}
                      placeholder={meta.defaultUser || 'username'}
                    />
                  </div>
                  <div style={{ ...s.field, flex: 1 }}>
                    <label style={s.label}>Password</label>
                    <input
                      style={s.input}
                      type="password"
                      name="password"
                      autoComplete="current-password"
                      value={form.password}
                      onChange={e => set('password', e.target.value)}
                      placeholder="••••••••"
                    />
                  </div>
                </div>

                {canSavePassword && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginTop: -2 }}>
                    <input
                      type="checkbox"
                      checked={form.savePassword}
                      onChange={e => set('savePassword', e.target.checked)}
                      style={{ width: 14, height: 14, cursor: 'pointer', accentColor: t.accent }}
                    />
                    <span style={{ fontSize: 12.5, color: t.textSecondary }}>Save password</span>
                    <span style={{ fontSize: 11, color: t.textMuted }}>(encrypted via OS keychain)</span>
                  </label>
                )}
              </>
            )}

            <div style={s.field}>
              <label style={s.label}>
                {form.type === 'mongodb' ? 'Default database' : 'Default schema'}{' '}
                <span style={{ color: t.textMuted, textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>(optional)</span>
              </label>
              <input
                style={s.input}
                name="database"
                autoComplete="off"
                value={form.database}
                onChange={e => set('database', e.target.value)}
                placeholder={form.type === 'postgres' ? 'postgres' : 'my_database'}
              />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button
                  type="button"
                  style={{ width: 34, height: 20, borderRadius: 9999, border: 'none', cursor: 'pointer', position: 'relative', flexShrink: 0, background: form.ssl ? t.accent : t.border, transition: 'background 150ms ease' }}
                  onClick={() => set('ssl', !form.ssl)}
                >
                  <div style={{ position: 'absolute', width: 14, height: 14, background: 'white', borderRadius: '50%', top: 3, left: form.ssl ? 17 : 3, transition: 'left 150ms ease' }}/>
                </button>
                <span style={{ fontSize: 13, color: t.textSecondary }}>Use SSL / TLS</span>
                {form.ssl && <span style={{ fontSize: 10, fontWeight: 600, color: t.accent, background: t.accentMuted, border: `1px solid ${t.borderAccent}`, padding: '1px 8px', borderRadius: 9999 }}>Encrypted</span>}
              </div>

              {form.ssl && (
                <div style={{ paddingLeft: 44, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={form.sslVerify}
                      onChange={e => set('sslVerify', e.target.checked)}
                      style={{ width: 14, height: 14, cursor: 'pointer', accentColor: t.accent }}
                    />
                    <span style={{ fontSize: 12.5, color: t.textSecondary }}>Verify server certificate</span>
                  </label>
                  {!form.sslVerify && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: t.colorWarning }}>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                        <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                      </svg>
                      Certificate not verified — server identity cannot be confirmed
                    </div>
                  )}
                </div>
              )}
            </div>

            {error && (
              <div style={s.errorBanner}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={t.colorError} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                <span>{error}</span>
              </div>
            )}

            {testResult && testResult.ok && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', background: t.colorSuccessBg, border: `1px solid ${t.colorSuccess}55`, borderRadius: 6, fontSize: 12, color: t.colorSuccess }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={t.colorSuccess} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
                <span>Connection successful{!isMongoUri && <> — {form.user}@{form.host}:{form.port || defaultPort(form.type)}</>}</span>
              </div>
            )}
            {testResult && !testResult.ok && (
              <div style={s.errorBanner}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={t.colorError} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                <span>{testResult.error}</span>
              </div>
            )}
          </div>

          <div style={s.footer}>
            <button
              type="button"
              style={{ ...s.testBtn, opacity: testing ? 0.7 : 1, cursor: testing ? 'wait' : 'pointer' }}
              onClick={runTest}
              disabled={testing || isConnecting}
            >{testing ? 'Testing…' : 'Test connection'}</button>
            <div style={{ flex: 1 }}/>
            <button
              type="submit"
              style={{ ...s.connectBtn, opacity: isConnecting ? 0.7 : 1 }}
              disabled={isConnecting}
            >
              {isConnecting
                ? <><div style={{ width: 12, height: 12, border: `2px solid ${t.textInverse}40`, borderTop: `2px solid ${t.textInverse}`, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }}/> Connecting…</>
                : <><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg> Connect</>
              }
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Picker card for one of the supported DB types.
function DbCard({ meta, onClick, t, s }: {
  meta: DbTypeMeta;
  onClick: () => void;
  t: Theme;
  s: Record<string, CSSProperties>;
}) {
  return (
    <div
      style={s.dbCard}
      onClick={onClick}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = t.borderAccent; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = t.border; }}
    >
      <div style={s.dbCardIcon}>{meta.icon(t.accent)}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: t.textPrimary }}>{meta.name}</span>
          <span style={s.badge}>{meta.badge}</span>
          <span style={{ fontSize: 11, color: t.textMuted }}>{meta.version}</span>
        </div>
        <span style={{ fontSize: 12, color: t.textMuted }}>{meta.desc}</span>
      </div>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={t.textMuted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="9 18 15 12 9 6"/>
      </svg>
    </div>
  );
}

// Saved-connection row on the picker step. Click = restore + go to form.
function SavedRow({ name, subtitle, meta, ssl, database, onClick, onForget, t }: {
  name: string;
  subtitle: string;
  meta: DbTypeMeta;
  ssl: boolean;
  database?: string;
  onClick: () => void;
  onForget: (e: React.MouseEvent) => void;
  t: Theme;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '10px 14px',
        background: hovered ? t.bgHover : 'transparent',
        border: `1px solid ${hovered ? t.borderAccent : t.borderSubtle}`,
        borderRadius: 7, cursor: 'pointer', minWidth: 0,
      }}
    >
      <div style={{ width: 28, height: 28, background: t.accentMuted, border: `1px solid ${t.borderAccent}`, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <span style={{ width: 18, height: 18, display: 'inline-flex' }}>{meta.icon(t.accent)}</span>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: t.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
        <div style={{ fontSize: 11, color: t.textMuted, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {subtitle}
          {database && <span> · {database}</span>}
          {ssl && <span style={{ color: t.accent }}> · SSL</span>}
        </div>
      </div>
      <button
        type="button"
        onClick={onForget}
        title={`Forget '${name}'`}
        style={{
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: t.textMuted, padding: '4px 6px', fontSize: 11, fontFamily: 'inherit',
          opacity: hovered ? 1 : 0,
          transition: 'opacity 100ms ease',
        }}
      >Forget</button>
    </div>
  );
}
