import { useState, CSSProperties } from 'react';
import type { Theme } from '../theme';

export interface ConnectionForm {
  name: string;
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
  ssl: boolean;
}

interface ConnectionManagerProps {
  onConnect: (form: ConnectionForm) => void;
  isConnecting: boolean;
  error: string | null;
  t: Theme;
}

export function ConnectionManager({ onConnect, isConnecting, error, t }: ConnectionManagerProps) {
  const [form, setForm] = useState<ConnectionForm>({
    name: 'Local MySQL', host: 'localhost', port: '3306',
    user: 'root', password: '', database: '', ssl: false,
  });
  const set = <K extends keyof ConnectionForm>(k: K, v: ConnectionForm[K]) =>
    setForm(p => ({ ...p, [k]: v }));

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
    <div style={s.overlay}>
      <div style={s.modal}>
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
            <div style={s.subtitle}>Connect to a MySQL server</div>
          </div>
        </div>

        <div style={s.body}>
          <div style={s.field}>
            <label style={s.label}>Connection name</label>
            <input style={s.input} value={form.name} onChange={e => set('name', e.target.value)} placeholder="My Database"/>
          </div>

          <div style={s.row}>
            <div style={{ ...s.field, flex: 1 }}>
              <label style={s.label}>Host</label>
              <input style={s.input} value={form.host} onChange={e => set('host', e.target.value)} placeholder="localhost"/>
            </div>
            <div style={{ ...s.field, width: 90 }}>
              <label style={s.label}>Port</label>
              <input style={{ ...s.input, fontFamily: 'monospace' }} value={form.port} onChange={e => set('port', e.target.value)} placeholder="3306"/>
            </div>
          </div>

          <div style={s.row}>
            <div style={{ ...s.field, flex: 1 }}>
              <label style={s.label}>Username</label>
              <input style={s.input} value={form.user} onChange={e => set('user', e.target.value)} placeholder="root"/>
            </div>
            <div style={{ ...s.field, flex: 1 }}>
              <label style={s.label}>Password</label>
              <input style={s.input} type="password" value={form.password} onChange={e => set('password', e.target.value)} placeholder="••••••••"/>
            </div>
          </div>

          <div style={s.field}>
            <label style={s.label}>
              Default schema{' '}
              <span style={{ color: t.textMuted, textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>(optional)</span>
            </label>
            <input style={s.input} value={form.database} onChange={e => set('database', e.target.value)} placeholder="my_database"/>
          </div>

          <div style={s.toggleRow}>
            <button
              style={{ width: 34, height: 20, borderRadius: 9999, border: 'none', cursor: 'pointer', position: 'relative', flexShrink: 0, transition: 'background 150ms ease', background: form.ssl ? t.accent : t.border }}
              onClick={() => set('ssl', !form.ssl)}
            >
              <div style={{ position: 'absolute', width: 14, height: 14, background: 'white', borderRadius: '50%', top: 3, left: form.ssl ? 17 : 3, transition: 'left 150ms ease' }}/>
            </button>
            <span style={s.toggleLabel}>Use SSL / TLS</span>
            {form.ssl && <span style={s.sslBadge}>Encrypted</span>}
          </div>

          {error && (
            <div style={s.errorBanner}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={t.colorError} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <span>{error}</span>
            </div>
          )}
        </div>

        <div style={s.footer}>
          <button style={s.testBtn}>Test connection</button>
          <div style={{ flex: 1 }}/>
          <button style={{ ...s.connectBtn, opacity: isConnecting ? 0.7 : 1 }} onClick={() => onConnect(form)} disabled={isConnecting}>
            {isConnecting
              ? <><div style={{ width: 12, height: 12, border: `2px solid ${t.textInverse}40`, borderTop: `2px solid ${t.textInverse}`, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }}/> Connecting…</>
              : <><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg> Connect</>
            }
          </button>
        </div>
      </div>
    </div>
  );
}
