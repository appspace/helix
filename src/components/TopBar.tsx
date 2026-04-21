import { CSSProperties } from 'react';
import type { Theme, ThemeName } from '../theme';

interface Tab {
  id: string;
  name: string;
  modified?: boolean;
}

interface TopBarProps {
  tabs: Tab[];
  activeTab: string;
  onTabChange: (id: string) => void;
  onNewTab: () => void;
  onCloseTab: (id: string) => void;
  connectionName: string;
  connectionStatus: 'connected' | 'disconnected' | 'error';
  themeName: ThemeName;
  onToggleTheme: () => void;
  t: Theme;
}

export function TopBar({ tabs, activeTab, onTabChange, onNewTab, onCloseTab, connectionName, connectionStatus, themeName, onToggleTheme, t }: TopBarProps) {
  const root: CSSProperties = {
    height: 40, background: t.bgToolbar, borderBottom: `1px solid ${t.border}`,
    display: 'flex', alignItems: 'center', flexShrink: 0, overflow: 'hidden',
  };
  const logoArea: CSSProperties = {
    width: 48, display: 'flex', alignItems: 'center', justifyContent: 'center',
    borderRight: `1px solid ${t.borderSubtle}`, alignSelf: 'stretch', flexShrink: 0,
  };
  const tabsWrap: CSSProperties = { display: 'flex', alignItems: 'stretch', flex: 1, overflow: 'hidden', alignSelf: 'stretch' };
  const tabBase: CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px 0 12px',
    fontSize: 12, color: t.textMuted, cursor: 'pointer',
    borderRight: `1px solid ${t.borderSubtle}`, minWidth: 0, flexShrink: 0,
    transition: 'background 150ms ease', position: 'relative', fontFamily: '"IBM Plex Sans", sans-serif',
  };
  const tabActive: CSSProperties = { ...tabBase, background: t.bgSurface, color: t.textPrimary, borderBottom: `2px solid ${t.accent}` };

  const statusColor = connectionStatus === 'connected' ? t.colorSuccess : connectionStatus === 'error' ? t.colorError : t.textMuted;

  return (
    <div style={root}>
      <div style={logoArea}>
        <svg width="22" height="22" viewBox="0 0 40 40" fill="none">
          <path d="M6 6 C6 6, 20 2, 20 20 C20 38, 6 34, 6 34" stroke={t.accent} strokeWidth="2.5" strokeLinecap="round"/>
          <path d="M16 6 C16 6, 30 2, 30 20 C30 38, 16 34, 16 34" stroke={t.accent} strokeWidth="2.5" strokeLinecap="round" opacity="0.5"/>
          <circle cx="6" cy="6" r="2.5" fill={t.accent}/>
          <circle cx="20" cy="20" r="2.5" fill={t.accent}/>
          <circle cx="6" cy="34" r="2.5" fill={t.accent}/>
        </svg>
      </div>

      <div style={tabsWrap}>
        {tabs.map(tab => (
          <div key={tab.id} style={activeTab === tab.id ? tabActive : tabBase} onClick={() => onTabChange(tab.id)}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={activeTab === tab.id ? t.accent : t.textMuted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
            </svg>
            <span style={{ maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tab.name}</span>
            {tab.modified && <span style={{ width: 5, height: 5, borderRadius: '50%', background: t.colorWarning, flexShrink: 0 }}/>}
            <button
              style={{ background: 'none', border: 'none', padding: '2px', cursor: 'pointer', color: t.textMuted, display: 'flex', alignItems: 'center', borderRadius: 3, marginLeft: 2 }}
              onClick={e => { e.stopPropagation(); onCloseTab(tab.id); }}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        ))}
        <button
          style={{ background: 'none', border: 'none', padding: '0 10px', cursor: 'pointer', color: t.textMuted, display: 'flex', alignItems: 'center', alignSelf: 'stretch', transition: 'color 150ms ease' }}
          onClick={onNewTab}
          title="New query"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </button>
      </div>

      <button
        onClick={onToggleTheme}
        title={themeName === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: t.textMuted, display: 'flex', alignItems: 'center', padding: '0 10px', alignSelf: 'stretch', transition: 'color 150ms ease' }}
      >
        {themeName === 'dark'
          ? <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
          : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
        }
      </button>

      <div style={{ width: 1, height: 18, background: t.borderSubtle }}/>

      <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '0 14px', flexShrink: 0 }}>
        <div style={{ width: 7, height: 7, borderRadius: '50%', background: statusColor, flexShrink: 0 }}/>
        <span style={{ fontSize: 11, color: t.textSecondary, fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{connectionName}</span>
      </div>
    </div>
  );
}
