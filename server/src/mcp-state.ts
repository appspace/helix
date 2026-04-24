let writesAllowed = false;

export function isMcpWritesAllowed(): boolean {
  return writesAllowed;
}

export function setMcpWritesAllowed(enabled: boolean): void {
  writesAllowed = enabled;
}

export function resetMcpState(): void {
  writesAllowed = false;
}
