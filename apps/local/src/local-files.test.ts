import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, renameSync, truncateSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_FILE_MAX_BYTES, importLocalFile, localFilesPlugin } from "./local-files";

const fixture = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "executor-file-import-"))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
);

it.effect("imports exact binary bytes without configuration", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const plugin = localFilesPlugin();
      expect(plugin.staticIntegrations?.({})).toMatchObject([
        { id: "files", kind: "executor", tools: [{ name: "importLocal" }] },
      ]);
      const dir = yield* fixture;
      const path = join(dir, "report.pdf");
      const bytes = Buffer.from([0, 255, 128, 10, 13, 42]);
      writeFileSync(path, bytes);
      expect(yield* importLocalFile(path)).toEqual({
        ok: true,
        data: {
          _tag: "ToolFile",
          name: "report.pdf",
          mimeType: "application/pdf",
          encoding: "base64",
          data: bytes.toString("base64"),
          byteLength: bytes.length,
        },
      });
    }),
  ),
);

it.effect("rejects relative paths", () =>
  Effect.gen(function* () {
    expect(yield* importLocalFile("relative.txt")).toMatchObject({
      ok: false,
      error: { code: "invalid_file_path" },
    });
  }),
);

it.effect("rejects directories", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const dir = yield* fixture;
      expect(yield* importLocalFile(dir)).toMatchObject({
        ok: false,
        error: { code: "not_regular_file" },
      });
    }),
  ),
);

it.effect(
  "reads newly created and replaced files and follows symlinks without reconfiguration",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* fixture;
        const path = join(dir, "file.txt");
        writeFileSync(path, "original");
        expect(yield* importLocalFile(path)).toMatchObject({
          ok: true,
          data: { data: Buffer.from("original").toString("base64") },
        });
        renameSync(path, join(dir, "original"));
        writeFileSync(path, "replacement");
        expect(yield* importLocalFile(path)).toMatchObject({
          ok: true,
          data: { data: Buffer.from("replacement").toString("base64") },
        });
        const link = join(dir, "link.txt");
        symlinkSync(path, link);
        expect(yield* importLocalFile(link)).toMatchObject({
          ok: true,
          data: { name: "link.txt", data: Buffer.from("replacement").toString("base64") },
        });
      }),
    ),
);

it.effect.skipIf(process.platform === "win32")("rejects FIFOs without waiting for a writer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const dir = yield* fixture;
      const path = join(dir, "pipe");
      execFileSync("mkfifo", [path]);
      expect(yield* importLocalFile(path)).toMatchObject({
        ok: false,
        error: { code: "not_regular_file" },
      });
    }),
  ),
);

it.effect("preserves binary bytes across chunk boundaries", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const dir = yield* fixture;
      const path = join(dir, "binary.PDF");
      const bytes = Buffer.alloc(2 * 64 * 1024 + 17);
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 256;
      writeFileSync(path, bytes);
      expect(yield* importLocalFile(path)).toMatchObject({
        ok: true,
        data: {
          data: bytes.toString("base64"),
          byteLength: bytes.length,
          mimeType: "application/pdf",
        },
      });
    }),
  ),
);

it.effect("supports empty files, unknown MIME, the size boundary, and missing files", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const dir = yield* fixture;
      const path = join(dir, "file.unknown");
      writeFileSync(path, "");
      expect(yield* importLocalFile(path)).toMatchObject({
        ok: true,
        data: { data: "", byteLength: 0, mimeType: "application/octet-stream" },
      });
      truncateSync(path, LOCAL_FILE_MAX_BYTES);
      expect(yield* importLocalFile(path)).toMatchObject({
        ok: true,
        data: { byteLength: LOCAL_FILE_MAX_BYTES },
      });
      truncateSync(path, LOCAL_FILE_MAX_BYTES + 1);
      expect(yield* importLocalFile(path)).toMatchObject({
        ok: false,
        error: { code: "file_too_large" },
      });
      rmSync(path);
      expect(yield* importLocalFile(path)).toMatchObject({
        ok: false,
        error: { code: "file_read_failed" },
      });
    }),
  ),
);
