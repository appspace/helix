import { useState, useEffect, useMemo, useRef } from 'react';
import type { CSSProperties } from 'react';
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
  // Only meaningful when type === 'mongodb' AND the user is editing via URI.
  connectionString?: string;
  // UI state: which input mode is active for the mongodb form. Persisted on
  // saved connections; in this redesign it's also driven by `lastEdited`.
  mongoMode?: 'fields' | 'uri';
}

interface ConnectionManagerProps {
  onConnect: (form: ConnectionForm) => void;
  isConnecting: boolean;
  error: string | null;
  t: Theme;
}

const DB_META = {
  mysql:    { name: 'MySQL',      badge: 'SQL'   as const, defaultPort: '3306'  },
  postgres: { name: 'PostgreSQL', badge: 'SQL'   as const, defaultPort: '5432'  },
  mongodb:  { name: 'MongoDB',    badge: 'NoSQL' as const, defaultPort: '27017' },
};

// ─────────────────────────────────────────────────────────────
// DB type detection — heuristic, "predicted" until the server confirms.
// ─────────────────────────────────────────────────────────────
function predictDbType(form: { connectionString?: string; port?: string }): DbType | null {
  const uri = form.connectionString?.trim();
  if (uri) {
    if (/^mongodb(\+srv)?:\/\//i.test(uri)) return 'mongodb';
    if (/^postgres(ql)?:\/\//i.test(uri))   return 'postgres';
    if (/^mysql:\/\//i.test(uri))           return 'mysql';
  }
  const p = parseInt(form.port ?? '', 10);
  if (p === 27017) return 'mongodb';
  if (p === 5432)  return 'postgres';
  if (p === 3306)  return 'mysql';
  return null;
}

// ─────────────────────────────────────────────────────────────
// URI ↔ fields sync
// ─────────────────────────────────────────────────────────────
function buildUri(f: { type: DbType; host: string; port: string; user: string; password: string; database: string }, maskPassword = false): string {
  if (!f.host) return '';
  const scheme = f.type === 'postgres' ? 'postgresql' : f.type === 'mongodb' ? 'mongodb' : 'mysql';
  const pw = f.password ? (maskPassword ? '***' : encodeURIComponent(f.password)) : '';
  const auth = f.user
    ? (pw ? `${encodeURIComponent(f.user)}:${pw}@` : `${encodeURIComponent(f.user)}@`)
    : '';
  const port = f.port ? `:${f.port}` : '';
  const db   = f.database ? `/${f.database}` : '';
  return `${scheme}://${auth}${f.host}${port}${db}`;
}

function parseUri(uri: string): Partial<Pick<ConnectionForm, 'host' | 'port' | 'user' | 'password' | 'database'>> {
  if (!uri) return {};
  try {
    // WHATWG URL doesn't recognize mysql:/postgresql:/mongodb: schemes — rewrite
    // to http: so it'll populate hostname/port/username/password for us, then
    // strip back out. mongodb+srv has no port (SRV records resolve it) so the
    // port extraction yields '' which is what we want.
    const norm = uri
      .replace(/^mysql:\/\//i,        'http://')
      .replace(/^postgresql?:\/\//i,  'http://')
      .replace(/^mongodb(\+srv)?:\/\//i, 'http://');
    const u = new URL(norm);
    return {
      host:     u.hostname || '',
      port:     u.port     || '',
      user:     u.username ? decodeURIComponent(u.username) : '',
      password: u.password ? decodeURIComponent(u.password) : '',
      database: (u.pathname || '').replace(/^\//, ''),
    };
  } catch { return {}; }
}

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

const initialForm = (): ConnectionForm => ({
  name: '',
  type: 'mysql',
  host: import.meta.env['VITE_DEFAULT_HOST'] ?? '',
  port: import.meta.env['VITE_DEFAULT_PORT'] ?? '',
  user: import.meta.env['VITE_DEFAULT_USER'] ?? '',
  password: '', database: '', ssl: false, sslVerify: true, savePassword: false,
  mongoMode: 'fields',
});

export function ConnectionManager({ onConnect, isConnecting, error, t }: ConnectionManagerProps) {
  const [saved, setSaved] = useState<SavedConnection[]>(() => listSavedConnections());
  const [form, setForm] = useState<ConnectionForm>(initialForm);
  const [lastEdited, setLastEdited] = useState<'uri' | 'fields'>('fields');
  const [appliedSaved, setAppliedSaved] = useState<string>('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: true; type: DbType } | { ok: false; error: string } | null>(null);
  const [canSavePassword, setCanSavePassword] = useState(false);

  useEffect(() => {
    let cancelled = false;
    electronAPI?.passwords.available().then(ok => { if (!cancelled) setCanSavePassword(ok); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const predicted = useMemo(() => predictDbType(form), [form.connectionString, form.port]);
  const effectiveType: DbType = predicted ?? form.type;

  // What we send to the backend. The form's `type` is the predicted one (so
  // the server picks the right driver). For mongo URIs we keep
  // `connectionString` and the existing `mongoMode: 'uri'` contract; otherwise
  // we strip it so a stale URI can't slip through with the fields payload.
  const buildSubmit = (): ConnectionForm => {
    const isMongoUri = effectiveType === 'mongodb' && lastEdited === 'uri' && !!form.connectionString;
    if (isMongoUri) {
      return { ...form, type: effectiveType, mongoMode: 'uri' };
    }
    const { connectionString: _cs, ...rest } = form;
    return { ...rest, type: effectiveType, mongoMode: effectiveType === 'mongodb' ? 'fields' : undefined };
  };

  const setField = <K extends keyof ConnectionForm>(k: K, v: ConnectionForm[K]) => {
    setForm(p => {
      const next = { ...p, [k]: v };
      // Re-derive the URI when any of the URI-relevant fields change. Type
      // pulls from the prediction (driven by port) so the scheme stays in sync.
      if (k === 'host' || k === 'port' || k === 'user' || k === 'password' || k === 'database') {
        const predictedType = predictDbType(next) ?? next.type;
        next.connectionString = buildUri({ ...next, type: predictedType });
      }
      return next;
    });
    setLastEdited('fields');
    setTestResult(null);
  };

  const setUri = (v: string) => {
    setForm(p => {
      const parsed = parseUri(v);
      return { ...p, connectionString: v, ...parsed };
    });
    setLastEdited('uri');
    setTestResult(null);
  };

  const setNameOnly = (v: string) => {
    setForm(p => ({ ...p, name: v }));
    if (appliedSaved && appliedSaved !== v) setAppliedSaved('');
  };

  const setSimple = <K extends keyof ConnectionForm>(k: K, v: ConnectionForm[K]) => {
    setForm(p => ({ ...p, [k]: v }));
    setTestResult(null);
  };

  const applySaved = (entry: SavedConnection) => {
    const next = formFromSaved(entry);
    // Reconstruct the URI so the dual-input shows what's behind this saved
    // connection. For mongo with a stored connectionString, prefer that.
    if (next.type !== 'mongodb' || !next.connectionString) {
      next.connectionString = buildUri(next);
    }
    setForm(next);
    setAppliedSaved(entry.name);
    setLastEdited(entry.type === 'mongodb' && entry.connectionString ? 'uri' : 'fields');
    setTestResult(null);
    if (entry.savePassword && electronAPI) {
      electronAPI.passwords.load(entry.name).then(pw => {
        if (pw === null) return;
        setForm(p => p.name === entry.name && p.password === '' ? { ...p, password: pw, connectionString: buildUri({ ...p, password: pw }) } : p);
      }).catch(() => {});
    }
  };

  const removeSaved = (name: string) => {
    deleteSavedConnection(name);
    electronAPI?.passwords.delete(name).catch(() => {});
    setSaved(listSavedConnections());
    if (appliedSaved === name) setAppliedSaved('');
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      await api.testConnection(buildSubmit());
      setTestResult({ ok: true, type: effectiveType });
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  };

  // ─────────────────────────────────────────────────────────
  // Styles
  // ─────────────────────────────────────────────────────────
  const s = {
    overlay: { position: 'fixed', inset: 0, background: t.bgBase, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300 } as CSSProperties,
    modal: { width: 500, maxWidth: '92vw', background: t.bgElevated, border: `1px solid ${t.border}`, borderRadius: 12, overflow: 'visible', boxShadow: t.shadowModal } as CSSProperties,
    header: { padding: '16px 22px', background: t.bgSurface, borderBottom: `1px solid ${t.border}`, borderRadius: '12px 12px 0 0', display: 'flex', alignItems: 'center', gap: 12 } as CSSProperties,
    title: { fontSize: 15, fontWeight: 600, color: t.textPrimary, fontFamily: '"Space Grotesk", sans-serif' } as CSSProperties,
    subtitle: { fontSize: 11, color: t.textMuted, marginTop: 1 } as CSSProperties,
    body: { padding: '16px 22px', display: 'flex', flexDirection: 'column', gap: 12 } as CSSProperties,
    label: { fontSize: 10, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: t.textMuted, display: 'block', marginBottom: 4 } as CSSProperties,
    input: { height: 32, background: t.bgInput, border: `1px solid ${t.border}`, borderRadius: 5, padding: '0 10px', fontSize: 12, color: t.textPrimary, outline: 'none', width: '100%', fontFamily: 'inherit', boxSizing: 'border-box' } as CSSProperties,
    footer: { padding: '12px 22px', borderTop: `1px solid ${t.border}`, background: t.bgSurface, borderRadius: '0 0 12px 12px', display: 'flex', gap: 8, alignItems: 'center' } as CSSProperties,
    testBtn: { height: 32, padding: '0 14px', background: 'transparent', border: `1px solid ${t.border}`, borderRadius: 5, fontSize: 12, color: t.textSecondary, cursor: 'pointer', fontFamily: 'inherit' } as CSSProperties,
    connectBtn: { height: 32, padding: '0 18px', background: t.accent, border: 'none', borderRadius: 5, fontSize: 12, fontWeight: 600, color: t.textInverse, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'inherit' } as CSSProperties,
    errorBanner: { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', background: t.colorErrorBg, border: `1px solid ${t.colorErrorBorder}`, borderRadius: 6, fontSize: 12, color: t.colorError, fontFamily: 'monospace' } as CSSProperties,
  };

  const badgeStatus: 'predicted' | 'connecting' | 'confirmed' | null =
    isConnecting || testing ? 'connecting'
    : testResult && testResult.ok ? 'confirmed'
    : predicted ? 'predicted'
    : null;
  const badgeType = testResult && testResult.ok ? testResult.type : predicted;

  return (
    <div style={s.overlay}>
      <div style={s.modal}>
        {/* Header */}
        <div style={s.header}>
          <svg width="20" height="20" viewBox="0 0 40 40" fill="none">
            <path d="M6 6 C6 6, 20 2, 20 20 C20 38, 6 34, 6 34" stroke={t.accent} strokeWidth="2.5" strokeLinecap="round"/>
            <path d="M16 6 C16 6, 30 2, 30 20 C30 38, 16 34, 16 34" stroke={t.accent} strokeWidth="2.5" strokeLinecap="round" opacity="0.5"/>
            <circle cx="6"  cy="6"  r="2.5" fill={t.accent}/>
            <circle cx="20" cy="20" r="2.5" fill={t.accent}/>
            <circle cx="6"  cy="34" r="2.5" fill={t.accent}/>
          </svg>
          <div style={{ flex: 1 }}>
            <div style={s.title}>New connection</div>
            <div style={s.subtitle}>Database type identified on connect</div>
          </div>
          <DetectionBadge status={badgeStatus} type={badgeType} t={t}/>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (isConnecting) return;
            onConnect(buildSubmit());
          }}
          autoComplete="on"
        >
          <div style={s.body}>
            <ConnectionNameField
              value={form.name}
              onChange={setNameOnly}
              saved={saved}
              appliedSaved={appliedSaved}
              onSelect={applySaved}
              onDelete={removeSaved}
              t={t}
            />

            <DualInput
              form={form}
              effectiveType={effectiveType}
              lastEdited={lastEdited}
              setLastEdited={setLastEdited}
              setField={setField}
              setUri={setUri}
              t={t}
            />

            {canSavePassword && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginTop: -2 }}>
                <input
                  type="checkbox"
                  checked={form.savePassword}
                  onChange={e => setSimple('savePassword', e.target.checked)}
                  style={{ width: 14, height: 14, cursor: 'pointer', accentColor: t.accent }}
                />
                <span style={{ fontSize: 12, color: t.textSecondary }}>Save password</span>
                <span style={{ fontSize: 11, color: t.textMuted }}>(encrypted via OS keychain)</span>
              </label>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button
                  type="button"
                  style={{ width: 32, height: 18, borderRadius: 9999, border: 'none', cursor: 'pointer', position: 'relative', flexShrink: 0, background: form.ssl ? t.accent : t.border, transition: 'background 150ms ease' }}
                  onClick={() => setSimple('ssl', !form.ssl)}
                >
                  <div style={{ position: 'absolute', width: 12, height: 12, background: 'white', borderRadius: '50%', top: 3, left: form.ssl ? 17 : 3, transition: 'left 150ms ease' }}/>
                </button>
                <span style={{ fontSize: 12, color: t.textSecondary }}>Use SSL / TLS</span>
                {form.ssl && <span style={{ fontSize: 10, fontWeight: 600, color: t.accent, background: t.accentMuted, border: `1px solid ${t.borderAccent}`, padding: '1px 7px', borderRadius: 9999 }}>Encrypted</span>}
              </div>

              {form.ssl && (
                <div style={{ paddingLeft: 42, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={form.sslVerify}
                      onChange={e => setSimple('sslVerify', e.target.checked)}
                      style={{ width: 14, height: 14, cursor: 'pointer', accentColor: t.accent }}
                    />
                    <span style={{ fontSize: 12, color: t.textSecondary }}>Verify server certificate</span>
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
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: t.colorSuccessBg, border: `1px solid ${t.colorSuccess}55`, borderRadius: 6, fontSize: 12, color: t.colorSuccess }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={t.colorSuccess} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
                <span>{DB_META[testResult.type].name} reachable{form.host && <> · {form.user}@{form.host}:{form.port || DB_META[testResult.type].defaultPort}</>}</span>
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
              style={{ ...s.connectBtn, opacity: isConnecting ? 0.75 : 1 }}
              disabled={isConnecting}
            >
              {isConnecting
                ? <><div style={{ width: 11, height: 11, border: `2px solid ${t.textInverse}40`, borderTop: `2px solid ${t.textInverse}`, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }}/> Connecting…</>
                : <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg> Connect</>
              }
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// DetectionBadge — predicted/connecting/confirmed pill
// ─────────────────────────────────────────────────────────────
function DetectionBadge({ status, type, t }: { status: 'predicted' | 'connecting' | 'confirmed' | null; type: DbType | null; t: Theme }) {
  if (status === 'connecting') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10, color: t.textMuted, whiteSpace: 'nowrap' }}>
        <div style={{ width: 10, height: 10, border: `2px solid ${t.border}`, borderTop: `2px solid ${t.accent}`, borderRadius: '50%', animation: 'spin 0.8s linear infinite', flexShrink: 0 }}/>
        Identifying…
      </span>
    );
  }
  if (status === 'predicted' && type) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 600,
        color: t.colorWarning, background: t.colorWarningBg, border: `1px solid ${t.colorWarning}40`,
        padding: '2px 9px', borderRadius: 9999, whiteSpace: 'nowrap' }}>
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        Likely {DB_META[type].name}
      </span>
    );
  }
  if (status === 'confirmed' && type) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 600,
        color: t.accent, background: t.accentMuted, border: `1px solid ${t.borderAccent}`,
        padding: '2px 9px', borderRadius: 9999, whiteSpace: 'nowrap' }}>
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
        {DB_META[type].name} · {DB_META[type].badge}
      </span>
    );
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// ConnectionNameField — name input + saved-connections dropdown
// ─────────────────────────────────────────────────────────────
function ConnectionNameField({ value, onChange, saved, appliedSaved, onSelect, onDelete, t }: {
  value: string;
  onChange: (v: string) => void;
  saved: SavedConnection[];
  appliedSaved: string;
  onSelect: (entry: SavedConnection) => void;
  onDelete: (name: string) => void;
  t: Theme;
}) {
  const [open, setOpen] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // While typing, filter to matching saved connections; on focus / after a
  // selection, show the full list so the user can browse.
  const filtered = isTyping && value.trim()
    ? saved.filter(c => c.name.toLowerCase().includes(value.toLowerCase()))
    : saved;

  useEffect(() => { setHighlight(-1); }, [value, isTyping, open]);
  useEffect(() => {
    if (highlight < 0 || !listRef.current) return;
    const row = listRef.current.children[highlight] as HTMLElement | undefined;
    row?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  const choose = (entry: SavedConnection) => {
    setIsTyping(false);
    onSelect(entry);
    setOpen(false);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      setOpen(true); e.preventDefault(); return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(h => Math.min(filtered.length - 1, h + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(h => Math.max(0, h - 1)); }
    else if (e.key === 'Enter' && highlight >= 0 && filtered[highlight]) {
      e.preventDefault(); choose(filtered[highlight]);
    }
    else if (e.key === 'Escape') {
      e.preventDefault();
      e.nativeEvent.stopImmediatePropagation();
      setOpen(false);
    }
  };

  const showDropdown = open && saved.length > 0;
  const subtitleFor = (c: SavedConnection): string => {
    if (c.host) return `${c.user ? c.user + '@' : ''}${c.host}${c.port ? ':' + c.port : ''}`;
    if (c.connectionString) {
      try { return new URL(c.connectionString.replace(/^mongodb\+srv:\/\//, 'mongodb://')).hostname; }
      catch { return ''; }
    }
    return '';
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <label style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: t.textMuted, display: 'block', marginBottom: 4 }}>
        Connection name <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: t.textMuted, opacity: 0.7 }}>— leave blank to not save</span>
      </label>
      <div style={{ position: 'relative' }}>
        <input
          name="connection-name"
          autoComplete="off"
          value={value}
          onChange={e => { onChange(e.target.value); setIsTyping(true); setOpen(true); }}
          onKeyDown={onKey}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          placeholder="Name this connection, or leave blank"
          style={{
            height: 32, width: '100%', background: t.bgInput,
            border: `1px solid ${showDropdown ? t.borderSubtle : t.border}`,
            borderRadius: showDropdown ? '5px 5px 0 0' : 5,
            padding: '0 32px 0 10px', fontSize: 12, color: t.textPrimary, outline: 'none',
            fontFamily: 'inherit', boxSizing: 'border-box',
          }}
        />
        <div style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: t.textMuted }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </div>
      </div>

      {showDropdown && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100,
          background: t.bgOverlay ?? t.bgElevated, border: `1px solid ${t.border}`, borderTop: 'none',
          borderRadius: '0 0 6px 6px',
          boxShadow: t.shadowLg, maxHeight: 280, overflowY: 'auto',
        }}>
          {filtered.length > 0
            ? <div ref={listRef}>
                {filtered.map((c, i) => (
                  <SavedRow
                    key={c.name}
                    entry={c}
                    subtitle={subtitleFor(c)}
                    typeLabel={DB_META[(c.type ?? 'mysql') as DbType].name}
                    highlighted={i === highlight}
                    isApplied={appliedSaved === c.name}
                    onSelect={() => choose(c)}
                    onDelete={(e) => { e.stopPropagation(); onDelete(c.name); }}
                    t={t}
                  />
                ))}
              </div>
            : <div style={{ padding: '8px 12px', fontSize: 11, color: t.textMuted, fontStyle: 'italic' }}>
                No saved connections match "{value}"
              </div>
          }
        </div>
      )}
    </div>
  );
}

function SavedRow({ entry, subtitle, typeLabel, highlighted, isApplied, onSelect, onDelete, t }: {
  entry: SavedConnection;
  subtitle: string;
  typeLabel: string;
  highlighted: boolean;
  isApplied: boolean;
  onSelect: () => void;
  onDelete: (e: React.MouseEvent) => void;
  t: Theme;
}) {
  const [hovered, setHovered] = useState(false);
  const active = hovered || highlighted;
  return (
    <div
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px',
        cursor: 'pointer',
        background: active ? t.bgHover : 'transparent',
        borderBottom: `1px solid ${t.borderSubtle}`,
        borderLeft: `2px solid ${highlighted ? t.accent : 'transparent'}`,
      }}
    >
      <div style={{ width: 6, height: 6, borderRadius: '50%', background: t.accent, flexShrink: 0, opacity: 0.7 }}/>
      <span style={{ fontSize: 12, color: t.textPrimary, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {entry.name}
      </span>
      <span style={{ fontSize: 9, color: t.textMuted, fontFamily: '"JetBrains Mono", monospace', flexShrink: 0 }}>{typeLabel}</span>
      <span style={{ fontSize: 10, color: t.textMuted, flexShrink: 0, maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subtitle}</span>
      {isApplied && <span style={{ fontSize: 9, color: t.accent, textTransform: 'uppercase', letterSpacing: '0.05em', flexShrink: 0 }}>current</span>}
      <button
        type="button"
        onMouseDown={onDelete}
        title={`Forget '${entry.name}'`}
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: t.colorError, display: 'flex', alignItems: 'center', padding: 2,
          borderRadius: 3, flexShrink: 0,
          opacity: hovered ? 1 : 0,
          transition: 'opacity 100ms ease',
        }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// DualInput — connection string + fields, both visible & synced
// ─────────────────────────────────────────────────────────────
function DualInput({ form, effectiveType, lastEdited, setLastEdited, setField, setUri, t }: {
  form: ConnectionForm;
  effectiveType: DbType;
  lastEdited: 'uri' | 'fields';
  setLastEdited: (v: 'uri' | 'fields') => void;
  setField: <K extends keyof ConnectionForm>(k: K, v: ConnectionForm[K]) => void;
  setUri: (v: string) => void;
  t: Theme;
}) {
  const uriActive = lastEdited === 'uri';
  const fieldsActive = lastEdited === 'fields';
  const accentBorder = `1px solid ${t.accent}`;
  const subtleBorder = `1px solid ${t.borderSubtle}`;
  const accentShadow = `0 0 0 2px ${t.accentMuted}`;

  // When the user is editing fields, mask the password in the rendered URI so
  // the actual password isn't readable in the connection string box. The form
  // state still holds the real password — it's just hidden from view.
  const displayUri = form.password && lastEdited === 'fields'
    ? buildUri({ ...form, type: effectiveType }, true)
    : form.connectionString ?? '';

  const label = (text: string) => (
    <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: t.textMuted, display: 'block', marginBottom: 4 }}>{text}</span>
  );
  const input: CSSProperties = {
    height: 32, background: t.bgInput, border: `1px solid ${t.border}`,
    borderRadius: 5, padding: '0 10px', fontSize: 12, color: t.textPrimary,
    outline: 'none', width: '100%', fontFamily: 'inherit', boxSizing: 'border-box',
  };

  const placeholderUri = effectiveType === 'postgres'
    ? 'postgresql://user@host:5432/dbname'
    : effectiveType === 'mongodb'
      ? 'mongodb://host:27017/database'
      : 'mysql://user:password@host:3306/db';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* URI box */}
      <div style={{
        padding: 10, borderRadius: 7,
        border: uriActive ? accentBorder : subtleBorder,
        boxShadow: uriActive ? accentShadow : 'none',
        background: t.bgSurface,
        transition: 'border-color 150ms, box-shadow 150ms',
      }}>
        {label('Connection string')}
        <input
          name="connection-string"
          autoComplete="off"
          value={displayUri}
          onChange={e => setUri(e.target.value)}
          onFocus={() => setLastEdited('uri')}
          placeholder={placeholderUri}
          style={{ ...input, fontFamily: '"JetBrains Mono", monospace', fontSize: 11 }}
        />
      </div>

      {/* "or" divider */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1, height: 1, background: t.borderSubtle }}/>
        <span style={{ fontSize: 10, color: t.textMuted, fontWeight: 500 }}>or</span>
        <div style={{ flex: 1, height: 1, background: t.borderSubtle }}/>
      </div>

      {/* Fields box */}
      <div
        style={{
          padding: 10, borderRadius: 7,
          border: fieldsActive ? accentBorder : subtleBorder,
          boxShadow: fieldsActive ? accentShadow : 'none',
          background: t.bgSurface,
          transition: 'border-color 150ms, box-shadow 150ms',
          display: 'flex', flexDirection: 'column', gap: 8,
        }}
        onFocusCapture={() => setLastEdited('fields')}
      >
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            {label('Host')}
            <input
              name="host"
              autoComplete="off"
              value={form.host}
              onChange={e => setField('host', e.target.value)}
              placeholder="localhost"
              style={input}
            />
          </div>
          <div style={{ width: 90 }}>
            {label('Port')}
            <input
              name="port"
              autoComplete="off"
              value={form.port}
              onChange={e => setField('port', e.target.value.replace(/\D/g, ''))}
              placeholder={DB_META[effectiveType].defaultPort}
              style={{ ...input, fontFamily: '"JetBrains Mono", monospace', fontSize: 11 }}
              inputMode="numeric"
            />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            {label('Username')}
            <input
              name="username"
              autoComplete="username"
              value={form.user}
              onChange={e => setField('user', e.target.value)}
              placeholder={effectiveType === 'mongodb' ? 'optional' : 'root'}
              style={input}
            />
          </div>
          <div style={{ flex: 1 }}>
            {label('Password')}
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              value={form.password}
              onChange={e => setField('password', e.target.value)}
              placeholder="••••••••"
              style={input}
            />
          </div>
        </div>
        <div>
          {label(effectiveType === 'mongodb' ? 'Default database' : 'Database')}
          <input
            name="database"
            autoComplete="off"
            value={form.database}
            onChange={e => setField('database', e.target.value)}
            placeholder={effectiveType === 'postgres' ? 'postgres' : 'my_database'}
            style={input}
          />
        </div>
      </div>
    </div>
  );
}
