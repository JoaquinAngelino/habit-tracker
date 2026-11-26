import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

// The subset of the D1 API the worker uses, over an in-memory SQLite database.
export function fakeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(migrations).sort()) db.exec(readFileSync(new URL(name, migrations), "utf8"));
  const statement = (sql, args = []) => ({
    // D1 takes an ArrayBuffer for a BLOB; node:sqlite wants a typed array.
    bind: (...values) => statement(sql, values.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v))),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return {
    sql: db,
    prepare: (sql) => statement(sql),
    async batch(list) {
      db.exec("BEGIN");
      try {
        const out = [];
        for (const s of list) out.push(await s.run());
        db.exec("COMMIT");
        return out;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}
