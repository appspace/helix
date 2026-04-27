export type ExportRow = Record<string, string | number | boolean | null>;

/**
 * RFC 4180-ish CSV formatting. Fields containing `"`, `,`, or any line-ending
 * character are wrapped in double quotes with internal quotes doubled. NULLs
 * become empty fields. Rows are separated by CRLF for Excel compatibility.
 */
function csvField(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function rowsToCsv(columns: string[], rows: ExportRow[]): string {
  const header = columns.map(csvField).join(',');
  if (rows.length === 0) return header + '\r\n';
  const body = rows.map(r => columns.map(c => csvField(r[c] ?? null)).join(',')).join('\r\n');
  return header + '\r\n' + body + '\r\n';
}

export function rowsToJson(rows: ExportRow[]): string {
  return JSON.stringify(rows, null, 2) + '\n';
}

export function downloadBlob(content: string, mime: string, filename: string): void {
  const blob = new Blob([content], { type: mime + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after the click has a chance to kick off the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[/\\?%*:|"<>]+/g, '_').replace(/\s+/g, '_') || 'results';
}
