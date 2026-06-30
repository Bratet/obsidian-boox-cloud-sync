export interface VaultIO {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface ObjectFetcher {
  object(key: string): Promise<ArrayBuffer>;
}
