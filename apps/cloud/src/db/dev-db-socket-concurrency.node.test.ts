// Regression for the dev-db PGlite socket protocol-interleaving bug (patched
// in patches/@electric-sql%2Fpglite-socket@0.1.4.patch).
//
// PGLiteSocketServer's QueryQueueManager used to enqueue each postgres wire
// FRAME (Parse, Bind, Execute, Sync) as its own queue entry against the one
// shared PGlite session. With more than one connection (the dev-db now allows
// many — see scripts/dev-db.ts maxConnections), two clients' extended-protocol
// pipelines interleaved: client A's Parse (5 params) ... client B's Parse
// (1 param) ... A's Bind now hits B's unnamed statement:
//
//   PostgresError: bind message supplies 5 parameters, but prepared
//   statement "" requires 1
//
// which surfaced in e2e as random 500s ("Failed to load tools", StorageError)
// on whichever request lost the race — the residual per-spec CI flakes after
// the connection-storm fix. The patch batches all frames of one socket data
// event into a single queue entry and adds handler affinity while a pipeline
// is open, so one client's Parse..Sync executes atomically.
//
// This test drives concurrent clients issuing unprepared parameterized queries
// with DIFFERENT parameter counts (the exact drizzle/postgres-js shape) through
// one PGLiteSocketServer and asserts zero protocol corruption.
// It also verifies that an idle-timeout error releases its handler; otherwise
// timed-out handlers permanently consume the server's connection limit.

import { describe, expect, it } from "@effect/vitest";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";

const PORT = 45998;
const IDLE_TIMEOUT_PORT = 45997;
const CLIENTS = 6;
const QUERIES_PER_CLIENT = 40;

describe("dev-db PGlite socket under concurrent connections", () => {
  it(
    "serves interleaved multi-connection pipelines without protocol corruption",
    { timeout: 60_000 },
    async () => {
      const db = await PGlite.create();
      const server = new PGLiteSocketServer({
        db,
        port: PORT,
        host: "127.0.0.1",
        maxConnections: 100,
      });
      await server.start();

      let ok = 0;
      const errors: string[] = [];

      const worker = async (id: number) => {
        const sql = postgres(`postgres://postgres:postgres@127.0.0.1:${PORT}/postgres`, {
          max: 1,
          idle_timeout: 0,
          connect_timeout: 10,
          fetch_types: false,
          prepare: true,
          onnotice: () => undefined,
        });
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: postgres.js is promise-native and the socket must be closed on every path
        try {
          for (let q = 0; q < QUERIES_PER_CLIENT; q++) {
            // Alternate 1-param and 5-param unprepared queries: maximally
            // collision-prone unnamed-statement shapes across connections.
            if ((id + q) % 2 === 0) {
              await sql.unsafe(`select $1::int as one`, [1]);
            } else {
              await sql.unsafe(`select $1::int, $2::text, $3::text, $4::text, $5::text`, [
                1,
                "b",
                "c",
                "d",
                "e",
              ]);
            }
            ok++;
          }
        } catch (cause) {
          // oxlint-disable-next-line executor/no-unknown-error-message -- test boundary: the raw PostgresError message IS the assertion payload
          errors.push(String(cause));
        } finally {
          // oxlint-disable-next-line executor/no-promise-catch -- test boundary: postgres.js is promise-native; a failed teardown must not mask the assertion
          await sql.end({ timeout: 5 }).catch(() => {});
        }
      };

      await Promise.all(Array.from({ length: CLIENTS }, (_, i) => worker(i)));
      await server.stop();
      await db.close();

      expect(errors, `protocol corruption under concurrency:\n${errors.join("\n")}`).toEqual([]);
      expect(ok).toBe(CLIENTS * QUERIES_PER_CLIENT);
    },
  );

  it("releases idle handlers so they do not exhaust the connection limit", async () => {
    const db = await PGlite.create();
    const server = new PGLiteSocketServer({
      db,
      port: IDLE_TIMEOUT_PORT,
      host: "127.0.0.1",
      maxConnections: 2,
      idleTimeout: 25,
    });
    await server.start();

    const clients = Array.from({ length: 3 }, () =>
      postgres(`postgres://postgres:postgres@127.0.0.1:${IDLE_TIMEOUT_PORT}/postgres`, {
        max: 1,
        idle_timeout: 0,
        connect_timeout: 1,
        fetch_types: false,
      }),
    );

    let activeConnections: number;
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: resources must be closed if a leaked handler rejects the third client
    try {
      for (const client of clients) {
        await client`select 1`;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      activeConnections = server.getStats().activeConnections;
    } finally {
      await Promise.all(clients.map((client) => client.end({ timeout: 1 })));
      await server.stop();
      await db.close();
    }

    expect(activeConnections).toBe(0);
  });
});
