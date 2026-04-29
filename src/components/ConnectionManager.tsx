import { useState, useEffect } from 'react';
import type { CSSProperties } from 'react';
import type { Theme } from '../theme';
import { api } from '../api';
import { listSavedConnections, deleteSavedConnection, type SavedConnection } from '../savedConnections';
import { electronAPI } from '../electronAPI';

export interface ConnectionForm {
  name: string;
  type: 'mysql' | 'postgres';
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
}

interface ConnectionManagerProps {
  onConnect: (form: ConnectionForm) => void;
  isConnecting: boolean;
  error: string | null;
  onDismiss?: () => void;
  t: Theme;
}

export function ConnectionManager({ onConnect, isConnecting, error, onDismiss, t }: ConnectionManagerProps) {
  const [saved, setSaved] = useState<SavedConnection[]>(() => listSavedConnections());
  const initialForm: ConnectionForm = saved[0]
    ? { ...saved[0], type: saved[0].type ?? 'mysql', password: '', sslVerify: saved[0].sslVerify ?? false, savePassword: saved[0].savePassword ?? false }
    : {
        name: 'Local MySQL',
        type: 'mysql',
        host: import.meta.env['VITE_DEFAULT_HOST'] ?? 'localhost',
        port: import.meta.env['VITE_DEFAULT_PORT'] ?? '3306',
        user: import.meta.env['VITE_DEFAULT_USER'] ?? 'root',
        password: '', database: '', ssl: false, sslVerify: true, savePassword: false,
      };
  const [form, setForm] = useState<ConnectionForm>(initialForm);
  // Track the saved entry currently reflected in the form, so we only auto-populate once per match.
  const [appliedSaved, setAppliedSaved] = useState<string>(saved[0]?.name ?? '');
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: true } | { ok: false; error: string } | null>(null);
  const [canSavePassword, setCanSavePassword] = useState(false);

  useEffect(() => {
    let cancelled = false;
    electronAPI?.passwords.available().then(ok => { if (!cancelled) setCanSavePassword(ok); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // If the initial saved entry has a stored password, load it on mount.
  useEffect(() => {
    const first = saved[0];
    if (!first?.savePassword || !electronAPI) return;
    let cancelled = false;
    electronAPI.passwords.load(first.name).then(pw => {
      if (cancelled || pw === null) return;
      setForm(p => p.name === first.name && p.password === '' ? { ...p, password: pw } : p);
    }).catch(() => {});
    return () => { cancelled = true; };
  // Intentional empty deps — we only want to load the password for the connection
  // that was active when the modal opened, not on every re-render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!onDismiss || isConnecting) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onDismiss, isConnecting]);

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      await api.testConnection(form);
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

  const setDbType = (t: 'mysql' | 'postgres') => {
    setForm(p => ({
      ...p,
      type: t,
      port: p.port === '3306' || p.port === '5432' || p.port === ''
        ? (t === 'mysql' ? '3306' : '5432')
        : p.port,
    }));
    setTestResult(null);
  };

  const applySaved = (entry: SavedConnection) => {
    setForm({ ...entry, type: entry.type ?? 'mysql', password: '', sslVerify: entry.sslVerify ?? false, savePassword: entry.savePassword ?? false });
    setAppliedSaved(entry.name);
    setSuggestOpen(false);
    if (entry.savePassword && electronAPI) {
      electronAPI.passwords.load(entry.name).then(pw => {
        if (pw === null) return;
        setForm(p => p.name === entry.name && p.password === '' ? { ...p, password: pw } : p);
      }).catch(() => {});
    }
  };

  const onNameChange = (value: string) => {
    setForm(p => ({ ...p, name: value }));
    if (appliedSaved && appliedSaved !== value) setAppliedSaved('');
    setHighlightIdx(-1);
  };

  const removeSaved = (name: string) => {
    deleteSavedConnection(name);
    electronAPI?.passwords.delete(name).catch(() => {});
    const next = listSavedConnections();
    setSaved(next);
    if (appliedSaved === name) setAppliedSaved('');
  };

  const filteredSaved = (() => {
    const q = form.name.trim().toLowerCase();
    if (!q) return saved;
    const starts = saved.filter(c => c.name.toLowerCase().startsWith(q));
    const includes = saved.filter(c => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q));
    return [...starts, ...includes];
  })();

  const s = {
    overlay: { position: 'fixed', inset: 0, background: t.bgBase + 'EE', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300 } as CSSProperties,
    modal: { width: 460, background: t.bgElevated, border: `1px solid ${t.border}`, borderRadius: 12, overflow: 'hidden', boxShadow: t.shadowModal } as CSSProperties,
    header: { padding: '20px 24px', borderBottom: `1px solid ${t.border}`, display: 'flex', alignItems: 'center', gap: 14, background: t.bgSurface } as CSSProperties,
    title: { fontSize: 16, fontWeight: 600, color: t.textPrimary, fontFamily: '"Space Grotesk", sans-serif' } as CSSProperties,
    subtitle: { fontSize: 12, color: t.textMuted, marginTop: 2 } as CSSProperties,
    body: { padding: 20, display: 'flex', flexDirection: 'column', gap: 14 } as CSSProperties,
    row: { display: 'flex', gap: 10 } as CSSProperties,
    field: { display: 'flex', flexDirection: 'column', gap: 5 } as CSSProperties,
    label: { fontSize: 10, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: t.textMuted, fontFamily: '"IBM Plex Sans", sans-serif' } as CSSProperties,
    input: { height: 32, background: t.bgInput, border: `1px solid ${t.border}`, borderRadius: 5, padding: '0 10px', fontFamily: '"IBM Plex Sans", sans-serif', fontSize: 13, color: t.textPrimary, outline: 'none', width: '100%' } as CSSProperties,
    toggleRow: { display: 'flex', alignItems: 'center', gap: 10 } as CSSProperties,
    toggleLabel: { fontSize: 13, color: t.textSecondary } as CSSProperties,
    sslBadge: { fontSize: 10, fontWeight: 600, color: t.accent, background: t.accentMuted, border: `1px solid ${t.borderAccent}`, padding: '2px 8px', borderRadius: 9999 } as CSSProperties,
    errorBanner: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', background: t.colorErrorBg, border: `1px solid ${t.colorErrorBorder}`, borderRadius: 6, fontSize: 12, color: t.colorError, fontFamily: 'monospace' } as CSSProperties,
    footer: { padding: '14px 20px', borderTop: `1px solid ${t.border}`, display: 'flex', alignItems: 'center', gap: 10, background: t.bgSurface } as CSSProperties,
    testBtn: { height: 32, padding: '0 14px', background: 'transparent', border: `1px solid ${t.border}`, borderRadius: 5, fontSize: 12, color: t.textSecondary, cursor: 'pointer', fontFamily: '"IBM Plex Sans", sans-serif' } as CSSProperties,
    connectBtn: { height: 32, padding: '0 18px', background: t.accent, border: 'none', borderRadius: 5, fontSize: 13, fontWeight: 600, color: t.textInverse, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontFamily: '"IBM Plex Sans", sans-serif' } as CSSProperties,
  };

  return (
    <div style={s.overlay} onClick={!isConnecting ? onDismiss : undefined}>
      <div style={s.modal} onClick={(e) => e.stopPropagation()}>
        <div style={s.header}>
          <svg width="20" height="20" viewBox="0 0 40 40" fill="none">
            <path d="M6 6 C6 6, 20 2, 20 20 C20 38, 6 34, 6 34" stroke={t.accent} strokeWidth="2.5" strokeLinecap="round"/>
            <path d="M16 6 C16 6, 30 2, 30 20 C30 38, 16 34, 16 34" stroke={t.accent} strokeWidth="2.5" strokeLinecap="round" opacity="0.5"/>
            <circle cx="6" cy="6" r="2.5" fill={t.accent}/>
            <circle cx="20" cy="20" r="2.5" fill={t.accent}/>
            <circle cx="6" cy="34" r="2.5" fill={t.accent}/>
          </svg>
          <div>
            <div style={s.title}>New connection</div>
            <div style={s.subtitle}>Connect to a {form.type === 'postgres' ? 'PostgreSQL' : 'MySQL'} server</div>
          </div>
        </div>

        <form
          onSubmit={(e) => { e.preventDefault(); if (!isConnecting) onConnect(form); }}
          autoComplete="on"
        >
          <div style={s.body}>
            <div style={s.field}>
              <label style={s.label}>Database type</label>
              <div style={{ display: 'flex', gap: 6 }}>
                {(['mysql', 'postgres'] as const).map(dbType => {
                  const active = form.type === dbType;
                  return (
                    <button
                      key={dbType}
                      type="button"
                      onClick={() => setDbType(dbType)}
                      style={{
                        height: 30, padding: '0 14px',
                        background: active ? t.accent : t.bgInput,
                        border: `1px solid ${active ? t.accent : t.border}`,
                        borderRadius: 5, fontSize: 12, fontWeight: active ? 600 : 400,
                        color: active ? t.textInverse : t.textSecondary,
                        cursor: 'pointer', fontFamily: '"IBM Plex Sans", sans-serif',
                        transition: 'background 120ms, color 120ms, border-color 120ms',
                      }}
                    >
                      {dbType === 'mysql' ? 'MySQL' : 'PostgreSQL'}
                    </button>
                  );
                })}
              </div>
            </div>

            <div style={s.field}>
              <label style={s.label}>
                Connection name
                {saved.length > 0 && (
                  <span style={{ color: t.textMuted, textTransform: 'none', letterSpacing: 0, fontWeight: 400, marginLeft: 6 }}>
                    — start typing to see saved connections
                  </span>
                )}
              </label>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <div style={{ position: 'relative', flex: 1 }}>
                  <input
                    style={s.input}
                    name="connection-name"
                    autoComplete="off"
                    value={form.name}
                    onChange={e => onNameChange(e.target.value)}
                    onFocus={() => { if (saved.length > 0) { setSuggestOpen(true); setHighlightIdx(-1); } }}
                    onBlur={() => setTimeout(() => setSuggestOpen(false), 120)}
                    onKeyDown={(e) => {
                      if (!suggestOpen || filteredSaved.length === 0) return;
                      if (e.key === 'ArrowDown') { e.preventDefault(); setHighlightIdx(i => Math.min(i + 1, filteredSaved.length - 1)); }
                      else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlightIdx(i => Math.max(i - 1, 0)); }
                      else if (e.key === 'Enter' && highlightIdx >= 0) { e.preventDefault(); applySaved(filteredSaved[highlightIdx]); }
                      else if (e.key === 'Escape') { e.preventDefault(); e.nativeEvent.stopImmediatePropagation(); setSuggestOpen(false); }
                    }}
                    placeholder="My Database"
                  />
                  {suggestOpen && filteredSaved.length > 0 && (
                    <div
                      role="listbox"
                      style={{
                        position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 10,
                        background: t.bgElevated, border: `1px solid ${t.border}`, borderRadius: 6,
                        boxShadow: t.shadowLg, maxHeight: 240, overflowY: 'auto', padding: 4,
                      }}
                    >
                      {filteredSaved.map((c, i) => {
                        const highlighted = i === highlightIdx;
                        return (
                          <div
                            key={c.name}
                            role="option"
                            aria-selected={highlighted}
                            onMouseEnter={() => setHighlightIdx(i)}
                            onMouseDown={(e) => { e.preventDefault(); applySaved(c); }}
                            style={{
                              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                              padding: '8px 10px', borderRadius: 4, cursor: 'pointer',
                              background: highlighted ? t.bgHover : 'transparent',
                            }}
                          >
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontSize: 12, color: t.textPrimary, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</div>
                              <div style={{ fontSize: 11, color: t.textMuted, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {c.user}@{c.host}:{c.port}
                                {c.database && <span style={{ marginLeft: 6 }}>· {c.database}</span>}
                                {c.ssl && <span style={{ marginLeft: 6, color: t.accent }}>· SSL</span>}
                              </div>
                            </div>
                            {appliedSaved === c.name && (
                              <span style={{ fontSize: 10, color: t.accent, textTransform: 'uppercase', letterSpacing: '0.05em' }}>current</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
                {appliedSaved && (
                  <button
                    type="button"
                    onClick={() => removeSaved(appliedSaved)}
                    title={`Forget '${appliedSaved}'`}
                    style={{ height: 32, padding: '0 10px', background: 'transparent', border: `1px solid ${t.border}`, borderRadius: 5, color: t.textMuted, cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' }}
                  >Forget</button>
                )}
              </div>
            </div>

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
                  style={{ ...s.input, fontFamily: 'monospace' }}
                  name="port"
                  autoComplete="off"
                  value={form.port}
                  onChange={e => set('port', e.target.value)}
                  placeholder={form.type === 'postgres' ? '5432' : '3306'}
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
                  placeholder="root"
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
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginTop: -4 }}>
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

            <div style={s.field}>
              <label style={s.label}>
                Default schema{' '}
                <span style={{ color: t.textMuted, textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>(optional)</span>
              </label>
              <input
                style={s.input}
                name="database"
                autoComplete="off"
                value={form.database}
                onChange={e => set('database', e.target.value)}
                placeholder="my_database"
              />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={s.toggleRow}>
                <button
                  type="button"
                  style={{ width: 34, height: 20, borderRadius: 9999, border: 'none', cursor: 'pointer', position: 'relative', flexShrink: 0, transition: 'background 150ms ease', background: form.ssl ? t.accent : t.border }}
                  onClick={() => set('ssl', !form.ssl)}
                >
                  <div style={{ position: 'absolute', width: 14, height: 14, background: 'white', borderRadius: '50%', top: 3, left: form.ssl ? 17 : 3, transition: 'left 150ms ease' }}/>
                </button>
                <span style={s.toggleLabel}>Use SSL / TLS</span>
                {form.ssl && <span style={s.sslBadge}>Encrypted</span>}
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
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', background: t.colorSuccessBg, border: `1px solid ${t.colorSuccess}55`, borderRadius: 6, fontSize: 12, color: t.colorSuccess }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={t.colorSuccess} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
                <span>Connection successful — {form.user}@{form.host}:{form.port || (form.type === 'postgres' ? 5432 : 3306)}</span>
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
            {onDismiss && (
              <button
                type="button"
                onClick={onDismiss}
                disabled={isConnecting}
                style={{ ...s.testBtn, opacity: isConnecting ? 0.5 : 1, cursor: isConnecting ? 'not-allowed' : 'pointer' }}
              >Cancel</button>
            )}
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
