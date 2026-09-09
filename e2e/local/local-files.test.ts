import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { scenario } from "../src/scenario";
import { Cli, RunDir } from "../src/services";
import { withLocalServer } from "./local-server";

scenario(
  "Local · import a binary file through QuickJS without startup grants",
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
        const bytes = Buffer.from([0, 255, 128, 10, 13, 42]);
        yield* withLocalServer(cli, runDir, (server) =>
          Effect.scoped(
            Effect.gen(function* () {
              // Created after daemon startup: no pre-registration or restart.
              writeFileSync(path, bytes);
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
              const result = yield* Effect.promise(() =>
                client.callTool({
                  name: "execute",
                  arguments: {
                    code: `
          const search = await tools.search({ query: "importLocal", limit: 10 });
          const imported = await tools.executor.files.importLocal({ path: ${JSON.stringify(path)} });
          const directory = await tools.executor.files.importLocal({ path: ${JSON.stringify(dir)} });
          return {
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
                result: { discovered: true, exact: true, directoryRejected: true },
              });
            }),
          ),
        );
      }),
    );
  }),
);
