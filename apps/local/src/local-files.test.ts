import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  rmSync,
  symlinkSync,
  renameSync,
  truncateSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { type ToolFile } from "@executor-js/sdk";
import {
  LOCAL_FILE_MAX_BYTES,
  LOCAL_FILES_EXECUTE_SKILL_APPENDIX,
  exportLocalFile,
  importLocalFile,
  localFilesPlugin,
} from "./local-files";

it("documents local file tools in host-specific execute guidance", () => {
  expect(LOCAL_FILES_EXECUTE_SKILL_APPENDIX).toContain(
    'tools.executor.files.importLocal({ path: "/absolute/path/file.pdf" })',
  );
  expect(LOCAL_FILES_EXECUTE_SKILL_APPENDIX).toContain(
    'tools.executor.files.exportLocal({ file: toolFile, path: "/absolute/path/file.pdf" })',
  );
  expect(LOCAL_FILES_EXECUTE_SKILL_APPENDIX).toContain("without overwriting");
});

const fixture = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "executor-file-import-"))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
);

it.effect("imports exact binary bytes without configuration", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const plugin = localFilesPlugin();
      expect(plugin.staticIntegrations?.({})).toMatchObject([
        {
          id: "files",
          kind: "executor",
          tools: [{ name: "importLocal" }, { name: "exportLocal" }],
        },
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
        error: { code: "file_not_found" },
      });
    }),
  ),
);

const exportFixture = (bytes = Buffer.from([0, 255, 128, 10, 13, 42])): ToolFile => ({
  _tag: "ToolFile",
  name: "../../untrusted.pdf",
  mimeType: "application/pdf",
  encoding: "base64",
  data: bytes.toString("base64"),
  byteLength: bytes.length,
});

it.effect(
  "exports exact bytes only to the explicit destination and leaves nothing else behind",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* fixture;
        const path = join(dir, "chosen.pdf");
        const file = exportFixture();
        expect(yield* exportLocalFile({ path, file })).toEqual({
          ok: true,
          data: { path, byteLength: file.byteLength },
        });
        expect(readFileSync(path).toString("base64")).toBe(file.data);
        expect(readdirSync(dir)).toEqual(["chosen.pdf"]);
      }),
    ),
);

it.effect("resolves symlink parents through the filesystem, preserving dot-dot semantics", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const dir = yield* fixture;
      const target = yield* fixture;
      mkdirSync(join(target, "child"));
      mkdirSync(join(target, "exports"));
      symlinkSync(join(target, "child"), join(dir, "alias"), "dir");
      // Do not use path.join here: it would collapse alias/.. lexically.
      const path = `${dir}${sep}alias${sep}..${sep}exports${sep}saved.pdf`;
      const file = exportFixture();
      expect(yield* exportLocalFile({ path, file })).toEqual({
        ok: true,
        data: { path, byteLength: file.byteLength },
      });
      expect(readFileSync(join(target, "exports", "saved.pdf")).toString("base64")).toBe(file.data);
      expect(readdirSync(join(target, "exports"))).toEqual(["saved.pdf"]);
      expect(readdirSync(dir)).toEqual(["alias"]);
    }),
  ),
);

it.effect.skipIf(process.platform === "win32")("exports with owner-only permissions", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const dir = yield* fixture;
      const path = join(dir, "private.pdf");
      expect(yield* exportLocalFile({ path, file: exportFixture() })).toMatchObject({ ok: true });
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }),
  ),
);

it.effect("never overwrites existing files or destination symlinks", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const dir = yield* fixture;
      const path = join(dir, "existing.txt");
      writeFileSync(path, "original");
      const file = exportFixture();
      expect(yield* exportLocalFile({ path, file })).toMatchObject({
        ok: false,
        error: { code: "file_exists" },
      });
      const link = join(dir, "link");
      symlinkSync(path, link);
      expect(yield* exportLocalFile({ path: link, file })).toMatchObject({
        ok: false,
        error: { code: "file_exists" },
      });
      const dangling = join(dir, "dangling");
      const absent = join(dir, "absent");
      symlinkSync(absent, dangling);
      expect(yield* exportLocalFile({ path: dangling, file })).toMatchObject({
        ok: false,
        error: { code: "file_exists" },
      });
      expect(readFileSync(path, "utf8")).toBe("original");
      expect(existsSync(absent)).toBe(false);
      expect(readdirSync(dir).sort()).toEqual(["dangling", "existing.txt", "link"]);
    }),
  ),
);

it.effect("rejects invalid paths and does not create missing parent directories", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const dir = yield* fixture;
      const file = exportFixture();
      expect(yield* exportLocalFile({ path: "relative.pdf", file })).toMatchObject({
        ok: false,
        error: { code: "invalid_file_path" },
      });
      expect(
        yield* exportLocalFile({ path: join(dir, "missing", "file.pdf"), file }),
      ).toMatchObject({ ok: false, error: { code: "file_write_failed" } });
      expect(yield* exportLocalFile({ path: dir, file })).toMatchObject({
        ok: false,
        error: { code: "file_exists" },
      });
      expect(readdirSync(dir)).toEqual([]);
    }),
  ),
);

it.effect(
  "rejects directory-only and NUL-containing destinations without filesystem side effects",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* fixture;
        const file = exportFixture();
        const paths = [
          sep,
          `${dir}${sep}`,
          `${dir}${sep}.`,
          `${dir}${sep}..`,
          `${dir}${sep}new${sep}`,
          `${dir}${sep}bad\u0000name`,
        ];
        for (const path of paths) {
          expect(yield* exportLocalFile({ path, file })).toMatchObject({
            ok: false,
            error: { code: "invalid_file_path" },
          });
        }
        expect(readdirSync(dir)).toEqual([]);
      }),
    ),
);

it.effect("rejects corrupt base64 and inaccurate lengths before creating files", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const dir = yield* fixture;
      const path = join(dir, "file.pdf");
      const file = exportFixture();
      for (const data of ["@@@", "YQ=", "YR==", "YQ", "YQ==junk"]) {
        expect(
          yield* exportLocalFile({ path, file: { ...file, data, byteLength: 1 } }),
        ).toMatchObject({ ok: false, error: { code: "invalid_file_data" } });
      }
      expect(yield* exportLocalFile({ path, file: { ...file, byteLength: -1 } })).toMatchObject({
        ok: false,
        error: { code: "invalid_file_data" },
      });
      expect(
        yield* exportLocalFile({ path, file: { ...file, byteLength: file.byteLength + 1 } }),
      ).toMatchObject({ ok: false, error: { code: "invalid_file_data" } });
      expect(readdirSync(dir)).toEqual([]);
    }),
  ),
);

it.effect("supports empty and maximum-sized exports and rejects oversized data", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const dir = yield* fixture;
      const empty = join(dir, "empty");
      expect(yield* exportLocalFile({ path: empty, file: exportFixture(Buffer.alloc(0)) })).toEqual(
        { ok: true, data: { path: empty, byteLength: 0 } },
      );
      expect(readFileSync(empty).length).toBe(0);
      const path = join(dir, "maximum");
      const bytes = Buffer.alloc(LOCAL_FILE_MAX_BYTES, 0xff);
      expect(yield* exportLocalFile({ path, file: exportFixture(bytes) })).toEqual({
        ok: true,
        data: { path, byteLength: bytes.length },
      });
      expect(readFileSync(path).equals(bytes)).toBe(true);
      const oversized = exportFixture(Buffer.alloc(LOCAL_FILE_MAX_BYTES + 1));
      expect(
        yield* exportLocalFile({ path: join(dir, "oversized"), file: oversized }),
      ).toMatchObject({ ok: false, error: { code: "file_too_large" } });
      expect(
        yield* exportLocalFile({
          path: join(dir, "oversized"),
          file: { ...oversized, byteLength: 0 },
        }),
      ).toMatchObject({ ok: false, error: { code: "file_too_large" } });
      expect(existsSync(join(dir, "oversized"))).toBe(false);
    }),
  ),
);

it.effect("concurrent exports have exactly one winner without overwriting", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const dir = yield* fixture;
      const path = join(dir, "winner");
      const files = [exportFixture(Buffer.from("one")), exportFixture(Buffer.from("two"))];
      const results = yield* Effect.all(
        files.map((file) => exportLocalFile({ path, file })),
        { concurrency: "unbounded" },
      );
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([
        {
          ok: false,
          error: {
            code: "file_exists",
            message: "The destination already exists; choose a different file path.",
          },
        },
      ]);
      const winner = results.findIndex((result) => result.ok);
      expect(readFileSync(path).toString("base64")).toBe(files[winner]?.data);
      expect(readdirSync(dir)).toEqual(["winner"]);
    }),
  ),
);
