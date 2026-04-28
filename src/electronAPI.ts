// Bridge to the main process via preload.cjs. Only present when running inside
// Electron — undefined in the browser dev server, so callers must guard.

interface PasswordAPI {
  available(): Promise<boolean>;
  save(name: string, password: string): Promise<void>;
  load(name: string): Promise<string | null>;
  delete(name: string): Promise<void>;
}

interface ElectronAPI {
  passwords: PasswordAPI;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export const electronAPI: ElectronAPI | undefined =
  typeof window !== 'undefined' ? window.electronAPI : undefined;
