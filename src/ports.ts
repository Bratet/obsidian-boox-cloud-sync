export interface VaultIO {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  readBinary?(path: string): Promise<ArrayBuffer>;
  write(path: string, content: string): Promise<void>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  remove(path: string): Promise<void>;
  // Create a directory, including any missing ancestors; a no-op when it
  // already exists. Optional: older adapters don't provide it.
  mkdir?(path: string): Promise<void>;
  // Remove an (empty) directory. May throw on a non-empty one — callers treat
  // this as best-effort cleanup. Optional: older adapters don't provide it.
  rmdir?(path: string): Promise<void>;
}

export interface ObjectFetcher {
  object(key: string): Promise<ArrayBuffer>;
}
