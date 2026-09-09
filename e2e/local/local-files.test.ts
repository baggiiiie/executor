import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { scenario } from "../src/scenario";
import { Cli, RunDir } from "../src/services";
import { withLocalServer } from "./local-server";

scenario(
  "Local · import and export binary files through QuickJS",
  { timeout: 300_000 },
  Effect.gen(function* () {
    const cli = yield* Cli;
    const runDir = yield* RunDir;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* Effect.acquireRelease(
          Effect.sync(() => mkdtempSync(join(tmpdir(), "executor-local-files-e2e-"))),
          (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
        );
        const path = join(dir, "report.pdf");
        const destination = join(dir, "saved.pdf");
        const bytes = Buffer.from([0, 255, 128, 10, 13, 42]);
        yield* withLocalServer(cli, runDir, (server) =>
          Effect.scoped(
            Effect.gen(function* () {
              // Created after daemon startup: no pre-registration or restart.
              writeFileSync(path, bytes);
              const actual = join(dir, "actual");
              mkdirSync(join(actual, "child"), { recursive: true });
              mkdirSync(join(actual, "exports"));
              symlinkSync(join(actual, "child"), join(dir, "alias"), "dir");
              const throughAlias = `${dir}${sep}alias${sep}..${sep}exports${sep}saved.pdf`;
              const client = yield* Effect.acquireRelease(
                Effect.promise(async () => {
                  const client = new Client({ name: "local-files-e2e", version: "1.0.0" });
                  await client.connect(
                    new StreamableHTTPClientTransport(
                      new URL("/mcp?artifacts=false", server.origin),
                      {
                        requestInit: { headers: { authorization: `Bearer ${server.token}` } },
                      },
                    ),
                  );
                  return client;
                }),
                (client) => Effect.promise(() => client.close()),
              );
              const skill = yield* Effect.promise(() =>
                client.callTool({ name: "skills", arguments: { name: "execute" } }),
              );
              expect(skill.isError).toBeFalsy();
              expect(JSON.stringify(skill.content)).toContain("tools.executor.files.importLocal");
              expect(JSON.stringify(skill.content)).toContain("tools.executor.files.exportLocal");
              const result = yield* Effect.promise(() =>
                client.callTool({
                  name: "execute",
                  arguments: {
                    code: `
          const search = await tools.search({ query: "importLocal", limit: 10 });
          const exports = await tools.search({ query: "exportLocal", limit: 10 });
          const imported = await tools.executor.files.importLocal({ path: ${JSON.stringify(path)} });
          const directory = await tools.executor.files.importLocal({ path: ${JSON.stringify(dir)} });
          if (!imported.ok) return imported;
          const saved = await tools.executor.files.exportLocal({ file: imported.data, path: ${JSON.stringify(destination)} });
          const duplicate = await tools.executor.files.exportLocal({ file: imported.data, path: ${JSON.stringify(destination)} });
          const resolvedParent = await tools.executor.files.exportLocal({ file: imported.data, path: ${JSON.stringify(throughAlias)} });
          return {
            resolvedParent: resolvedParent.ok && resolvedParent.data.path === ${JSON.stringify(throughAlias)},
            exportDiscovered: exports.items.some(item => item.path === "executor.files.exportLocal"),
            saved: saved.ok && saved.data.path === ${JSON.stringify(destination)} && saved.data.byteLength === ${bytes.length},
            overwriteRefused: !duplicate.ok && duplicate.error.code === "file_exists",
            discovered: search.items.some(item => item.path === "executor.files.importLocal"),
            exact: imported.ok && imported.data._tag === "ToolFile"
              && imported.data.name === "report.pdf" && imported.data.mimeType === "application/pdf"
              && imported.data.encoding === "base64" && imported.data.byteLength === ${bytes.length}
              && imported.data.data === ${JSON.stringify(bytes.toString("base64"))},
            directoryRejected: !directory.ok && directory.error.code === "not_regular_file"
          };
        `,
                  },
                }),
              );
              writeFileSync(join(runDir, "mcp-result.json"), JSON.stringify(result, null, 2));
              expect(result.isError).toBeFalsy();
              expect(result.structuredContent).toMatchObject({
                status: "completed",
                result: {
                  discovered: true,
                  exact: true,
                  directoryRejected: true,
                  exportDiscovered: true,
                  saved: true,
                  overwriteRefused: true,
                  resolvedParent: true,
                },
              });
              expect(readFileSync(destination).equals(bytes)).toBe(true);
              expect(readFileSync(join(actual, "exports", "saved.pdf")).equals(bytes)).toBe(true);
              expect(readdirSync(join(actual, "exports"))).toEqual(["saved.pdf"]);
              expect(readdirSync(dir).sort()).toEqual([
                "actual",
                "alias",
                "report.pdf",
                "saved.pdf",
              ]);
            }),
          ),
        );
      }),
    );
  }),
);
