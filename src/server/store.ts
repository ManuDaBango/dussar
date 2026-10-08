// ---------------------------------------------------------------------------
// store.ts: where games are saved.
//
// A "store" is anything that can save a room and load them all back.
// SqliteStore writes to a small database FILE on disk (so games survive the server
// restarting). MemoryStore keeps things in memory only (used by the tests).
// The rest of the program only talks to the Store "shape", so we can swap the storage
// later (for example to a hosted database) without touching the game or the rooms.
// ---------------------------------------------------------------------------
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface StoredRoom {
  code: string;
  /** The whole room as JSON text. */
  data: string;
  updatedAt: number;
}

export interface Store {
  save(room: StoredRoom): void;
  loadAll(): StoredRoom[];
  /** Forget rooms nobody has touched since `olderThan` (milliseconds since 1970). */
  prune(olderThan: number): void;
}

export class MemoryStore implements Store {
  private rooms = new Map<string, StoredRoom>();
  save(room: StoredRoom): void {
    this.rooms.set(room.code, { ...room });
  }
  loadAll(): StoredRoom[] {
    return [...this.rooms.values()];
  }
  prune(olderThan: number): void {
    for (const [code, r] of this.rooms) if (r.updatedAt < olderThan) this.rooms.delete(code);
  }
}

export class SqliteStore implements Store {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        code TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  save(room: StoredRoom): void {
    this.db
      .prepare('INSERT OR REPLACE INTO rooms (code, data, updated_at) VALUES (?, ?, ?)')
      .run(room.code, room.data, room.updatedAt);
  }

  loadAll(): StoredRoom[] {
    const rows = this.db.prepare('SELECT code, data, updated_at FROM rooms').all() as {
      code: string;
      data: string;
      updated_at: number;
    }[];
    return rows.map((r) => ({ code: r.code, data: r.data, updatedAt: r.updated_at }));
  }

  prune(olderThan: number): void {
    this.db.prepare('DELETE FROM rooms WHERE updated_at < ?').run(olderThan);
  }

  close(): void {
    this.db.close();
  }
}
