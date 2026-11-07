// MongoDB store with in-memory fallback (spec §10b: demo must run if Mongo is unreachable).
import "dotenv/config";
import { MongoClient, type Db } from "mongodb";

export type Filter = Record<string, unknown>;

export interface Store {
  kind: "mongo" | "memory";
  warning?: string;
  insertMany(coll: string, docs: object[]): Promise<void>;
  find<T = any>(coll: string, filter?: Filter, opts?: { sort?: Record<string, 1 | -1>; limit?: number }): Promise<T[]>;
  updateOne(coll: string, filter: Filter, set: Record<string, unknown>, push?: Record<string, unknown>): Promise<void>;
  count(coll: string, filter?: Filter): Promise<number>;
  nextSeq(key: string, n?: number): Promise<number>; // returns first of n reserved numbers
  close(): Promise<void>;
}

class MongoStore implements Store {
  kind = "mongo" as const;
  constructor(private client: MongoClient, private db: Db) {}
  async insertMany(coll: string, docs: object[]) {
    if (docs.length) await this.db.collection(coll).insertMany(docs.map((d) => ({ ...d })));
  }
  async find<T>(coll: string, filter: Filter = {}, opts: { sort?: Record<string, 1 | -1>; limit?: number } = {}) {
    let cur = this.db.collection(coll).find(filter, { projection: { _id: 0 } });
    if (opts.sort) cur = cur.sort(opts.sort);
    if (opts.limit) cur = cur.limit(opts.limit);
    return (await cur.toArray()) as T[];
  }
  async updateOne(coll: string, filter: Filter, set: Record<string, unknown>, push?: Record<string, unknown>) {
    await this.db.collection(coll).updateOne(filter, { $set: set, ...(push ? { $push: push as any } : {}) });
  }
  async count(coll: string, filter: Filter = {}) {
    return this.db.collection(coll).countDocuments(filter);
  }
  async nextSeq(key: string, n = 1) {
    const r = await this.db.collection<{ _id: string; seq: number }>("counters").findOneAndUpdate(
      { _id: key }, { $inc: { seq: n } }, { upsert: true, returnDocument: "after" });
    return r!.seq - n + 1;
  }
  close() { return this.client.close(); }
}

const matches = (doc: any, filter: Filter) =>
  Object.entries(filter).every(([k, v]) =>
    v && typeof v === "object" && "$in" in (v as any) ? (v as any).$in.includes(doc[k]) : doc[k] === v);

class MemoryStore implements Store {
  kind = "memory" as const;
  private data = new Map<string, any[]>();
  private seqs = new Map<string, number>();
  constructor(public warning?: string) {}
  private c(coll: string) {
    if (!this.data.has(coll)) this.data.set(coll, []);
    return this.data.get(coll)!;
  }
  async insertMany(coll: string, docs: object[]) { this.c(coll).push(...docs.map((d) => structuredClone(d))); }
  async find<T>(coll: string, filter: Filter = {}, opts: { sort?: Record<string, 1 | -1>; limit?: number } = {}) {
    let rows = this.c(coll).filter((d) => matches(d, filter));
    if (opts.sort) {
      const [[k, dir]] = Object.entries(opts.sort);
      rows = [...rows].sort((a, b) => (a[k] < b[k] ? -dir : a[k] > b[k] ? dir : 0));
    }
    return structuredClone(opts.limit ? rows.slice(0, opts.limit) : rows) as T[];
  }
  async updateOne(coll: string, filter: Filter, set: Record<string, unknown>, push?: Record<string, unknown>) {
    const doc = this.c(coll).find((d) => matches(d, filter));
    if (!doc) return;
    Object.assign(doc, structuredClone(set));
    for (const [k, v] of Object.entries(push ?? {})) (doc[k] ??= []).push(structuredClone(v));
  }
  async count(coll: string, filter: Filter = {}) { return this.c(coll).filter((d) => matches(d, filter)).length; }
  async nextSeq(key: string, n = 1) {
    const cur = this.seqs.get(key) ?? 0;
    this.seqs.set(key, cur + n);
    return cur + 1;
  }
  async close() {}
}

let singleton: Promise<Store> | undefined;

export function getStore(): Promise<Store> {
  return (singleton ??= (async () => {
    const uri = process.env.MONGODB_URI;
    if (!uri) return new MemoryStore("MONGODB_URI not set: using in-memory store (data is lost on restart)");
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 6000 });
    try {
      await client.connect();
      const db = client.db(process.env.MONGODB_DB ?? "rosetta");
      await db.collection("observations").createIndex({ sessionId: 1, runId: 1 }, { unique: true });
      await db.collection("events").createIndex({ sessionId: 1, ts: 1 });
      return new MongoStore(client, db);
    } catch (e: any) {
      await client.close().catch(() => {});
      const warning = `MongoDB unreachable (${e?.message ?? e}): using in-memory store`;
      console.warn(`WARN ${warning}`);
      return new MemoryStore(warning);
    }
  })());
}
