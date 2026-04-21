export type ThemeName = 'dark' | 'light';

export interface Theme {
  bgBase: string;
  bgSurface: string;
  bgElevated: string;
  bgOverlay: string;
  bgInput: string;
  bgHover: string;
  bgSelected: string;
  bgToolbar: string;
  borderSubtle: string;
  border: string;
  borderStrong: string;
  borderAccent: string;
  accent: string;
  accentDim: string;
  accentBright: string;
  accentMuted: string;
  accentGlow: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textInverse: string;
  textAccent: string;
  textLink: string;
  colorError: string;
  colorErrorBg: string;
  colorErrorBorder: string;
  colorWarning: string;
  colorWarningBg: string;
  colorSuccess: string;
  colorSuccessBg: string;
  colorInfo: string;
  colorInfoBg: string;
  sqlKeyword: string;
  sqlString: string;
  sqlNumber: string;
  sqlComment: string;
  sqlFunction: string;
  sqlType: string;
  sqlTable: string;
  sqlOperator: string;
  shadowSm: string;
  shadowMd: string;
  shadowLg: string;
  shadowModal: string;
  focusRing: string;
  errorRing: string;
  scrollbarThumb: string;
  spinnerTrack: string;
  spinnerHead: string;
}

export const DARK: Theme = {
  bgBase:       '#0B0F14',
  bgSurface:    '#111720',
  bgElevated:   '#171E2A',
  bgOverlay:    '#1E2736',
  bgInput:      '#0E1420',
  bgHover:      '#FFFFFF0D',
  bgSelected:   '#00C9B114',
  bgToolbar:    '#0E1420',
  borderSubtle: '#1A2233',
  border:       '#2A3548',
  borderStrong: '#3A4B63',
  borderAccent: '#00C9B140',
  accent:       '#00C9B1',
  accentDim:    '#009E8C',
  accentBright: '#1DEDD8',
  accentMuted:  '#00C9B11A',
  accentGlow:   '0 0 0 2px #00C9B133',
  textPrimary:  '#E2EAF4',
  textSecondary:'#8896AA',
  textMuted:    '#4F617A',
  textInverse:  '#0B0F14',
  textAccent:   '#00C9B1',
  textLink:     '#4D9EF5',
  colorError:       '#F0614A',
  colorErrorBg:     '#F0614A18',
  colorErrorBorder: '#F0614A40',
  colorWarning:     '#F0A930',
  colorWarningBg:   '#F0A93018',
  colorSuccess:     '#3CCF91',
  colorSuccessBg:   '#3CCF9118',
  colorInfo:        '#4D9EF5',
  colorInfoBg:      '#4D9EF518',
  sqlKeyword:  '#569CD6',
  sqlString:   '#CE9178',
  sqlNumber:   '#B5CEA8',
  sqlComment:  '#4F617A',
  sqlFunction: '#DCDCAA',
  sqlType:     '#4EC9B0',
  sqlTable:    '#9CDCFE',
  sqlOperator: '#D4D4D4',
  shadowSm: '0 1px 2px #00000050',
  shadowMd: '0 4px 12px #00000066, 0 1px 3px #00000040',
  shadowLg: '0 12px 32px #00000088, 0 2px 8px #00000055',
  shadowModal: '0 24px 64px #00000099, 0 2px 8px #00000060',
  focusRing:   '0 0 0 2px #00C9B133',
  errorRing:   '0 0 0 2px #F0614A33',
  scrollbarThumb: '#2A3548',
  spinnerTrack:   '#1A2233',
  spinnerHead:    '#00C9B1',
};

export const LIGHT: Theme = {
  bgBase:       '#EEF1F6',
  bgSurface:    '#FFFFFF',
  bgElevated:   '#F8FAFD',
  bgOverlay:    '#EDF1F7',
  bgInput:      '#FFFFFF',
  bgHover:      '#00000008',
  bgSelected:   '#009B8A0F',
  bgToolbar:    '#F4F6FA',
  borderSubtle: '#E6EAF2',
  border:       '#CDD3DF',
  borderStrong: '#B0BBC8',
  borderAccent: '#009B8A30',
  accent:       '#007F72',
  accentDim:    '#006159',
  accentBright: '#009B8A',
  accentMuted:  '#007F7212',
  accentGlow:   '0 0 0 2px #007F7225',
  textPrimary:  '#111827',
  textSecondary:'#4B5563',
  textMuted:    '#9CA3AF',
  textInverse:  '#FFFFFF',
  textAccent:   '#007F72',
  textLink:     '#1D4ED8',
  colorError:       '#DC2626',
  colorErrorBg:     '#DC262610',
  colorErrorBorder: '#DC262630',
  colorWarning:     '#B45309',
  colorWarningBg:   '#B4530912',
  colorSuccess:     '#059669',
  colorSuccessBg:   '#05966912',
  colorInfo:        '#1D4ED8',
  colorInfoBg:      '#1D4ED810',
  sqlKeyword:  '#0070C1',
  sqlString:   '#A31515',
  sqlNumber:   '#098658',
  sqlComment:  '#9CA3AF',
  sqlFunction: '#795E26',
  sqlType:     '#267F99',
  sqlTable:    '#001080',
  sqlOperator: '#383838',
  shadowSm: '0 1px 3px rgba(0,0,0,0.08)',
  shadowMd: '0 4px 12px rgba(0,0,0,0.10), 0 1px 3px rgba(0,0,0,0.06)',
  shadowLg: '0 12px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.08)',
  shadowModal: '0 24px 48px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.08)',
  focusRing:   '0 0 0 2px #007F7228',
  errorRing:   '0 0 0 2px #DC262625',
  scrollbarThumb: '#CDD3DF',
  spinnerTrack:   '#E6EAF2',
  spinnerHead:    '#007F72',
};
