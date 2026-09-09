import { constants } from "node:fs";
import { link, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, sep } from "node:path";
import { Data, Effect, Schema } from "effect";
import { definePlugin, tool, ToolFileSchema, ToolResult } from "@executor-js/sdk";

export const LOCAL_FILE_MAX_BYTES = 5 * 1024 * 1024;

class LocalFileError extends Data.TaggedError("LocalFileError")<{
  readonly code:
    | "invalid_file_path"
    | "not_regular_file"
    | "file_too_large"
    | "file_read_failed"
    | "invalid_file_data"
    | "file_exists"
    | "file_write_failed";
  readonly message: string;
}> {}

const Input = Schema.Struct({ path: Schema.String });
const inputSchema = Schema.toStandardSchemaV1(Schema.toStandardJSONSchemaV1(Input));
const outputSchema = Schema.toStandardSchemaV1(Schema.toStandardJSONSchemaV1(ToolFileSchema));

const ExportInput = Schema.Struct({ path: Schema.String, file: ToolFileSchema });
const ExportOutput = Schema.Struct({ path: Schema.String, byteLength: Schema.Int });
const exportInputSchema = Schema.toStandardSchemaV1(Schema.toStandardJSONSchemaV1(ExportInput));
const exportOutputSchema = Schema.toStandardSchemaV1(Schema.toStandardJSONSchemaV1(ExportOutput));
const hasFileSystemCode = Schema.is(Schema.Struct({ code: Schema.String }));

const mimeTypes: Readonly<Record<string, string>> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".zip": "application/zip",
};

export const importLocalFile = (path: string) =>
  Effect.gen(function* () {
    if (!isAbsolute(path)) {
      return yield* new LocalFileError({
        code: "invalid_file_path",
        message: "Local imports require an absolute file path.",
      });
    }
    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        // Follow symlinks normally. NONBLOCK prevents opening a FIFO from hanging;
        // inspect the opened descriptor before reading any bytes.
        try: () => open(path, constants.O_RDONLY | constants.O_NONBLOCK),
        catch: () =>
          new LocalFileError({ code: "file_read_failed", message: "Cannot open the local file." }),
      }),
      (handle) =>
        Effect.gen(function* () {
          const stat = yield* Effect.tryPromise({
            try: () => handle.stat(),
            catch: () =>
              new LocalFileError({
                code: "file_read_failed",
                message: "Cannot inspect the local file.",
              }),
          });
          if (!stat.isFile()) {
            return yield* new LocalFileError({
              code: "not_regular_file",
              message: "Local imports require a regular file, not a directory or device.",
            });
          }
          if (stat.size > LOCAL_FILE_MAX_BYTES) {
            return yield* new LocalFileError({
              code: "file_too_large",
              message: "Local imports are limited to 5 MiB.",
            });
          }
          // Read bounded chunks rather than allocating the full limit for every
          // small file. The extra byte detects growth past the limit after fstat.
          const chunks: Buffer[] = [];
          let length = 0;
          while (length <= LOCAL_FILE_MAX_BYTES) {
            const chunk = Buffer.alloc(Math.min(64 * 1024, LOCAL_FILE_MAX_BYTES + 1 - length));
            const read = yield* Effect.tryPromise({
              try: () => handle.read(chunk, 0, chunk.length, null),
              catch: () =>
                new LocalFileError({
                  code: "file_read_failed",
                  message: "Cannot read the local file.",
                }),
            });
            if (read.bytesRead === 0) break;
            chunks.push(chunk.subarray(0, read.bytesRead));
            length += read.bytesRead;
          }
          if (length > LOCAL_FILE_MAX_BYTES) {
            return yield* new LocalFileError({
              code: "file_too_large",
              message: "Local imports are limited to 5 MiB.",
            });
          }
          return ToolResult.ok({
            _tag: "ToolFile" as const,
            name: basename(path),
            mimeType: mimeTypes[extname(path).toLowerCase()] ?? "application/octet-stream",
            encoding: "base64" as const,
            data: Buffer.concat(chunks, length).toString("base64"),
            byteLength: length,
          });
        }),
      (handle) =>
        Effect.tryPromise({
          try: () => handle.close(),
          catch: () =>
            new LocalFileError({
              code: "file_read_failed",
              message: "Cannot close the local file.",
            }),
        }).pipe(Effect.ignore),
    );
  }).pipe(
    Effect.catchTag("LocalFileError", ({ code, message }) =>
      Effect.succeed(ToolResult.fail({ code, message })),
    ),
  );

export const exportLocalFile = ({ path, file }: typeof ExportInput.Type) =>
  Effect.gen(function* () {
    const filename = basename(path);
    if (
      !isAbsolute(path) ||
      path.includes("\u0000") ||
      filename === "" ||
      filename === "." ||
      filename === ".." ||
      path.endsWith(sep) ||
      path.endsWith("/")
    ) {
      return yield* new LocalFileError({
        code: "invalid_file_path",
        message: "Local exports require an absolute destination file path.",
      });
    }
    // Bound decoding independently of the caller's byteLength metadata.
    if (
      file.byteLength > LOCAL_FILE_MAX_BYTES ||
      file.data.length > 4 * Math.ceil(LOCAL_FILE_MAX_BYTES / 3)
    ) {
      return yield* new LocalFileError({
        code: "file_too_large",
        message: "Local exports are limited to 5 MiB.",
      });
    }
    const bytes = Buffer.from(file.data, "base64");
    if (bytes.length > LOCAL_FILE_MAX_BYTES) {
      return yield* new LocalFileError({
        code: "file_too_large",
        message: "Local exports are limited to 5 MiB.",
      });
    }
    // Buffer's decoder silently accepts malformed input; require canonical base64
    // and accurate metadata instead of writing truncated or corrupted content.
    if (bytes.toString("base64") !== file.data || bytes.length !== file.byteLength) {
      return yield* new LocalFileError({
        code: "invalid_file_data",
        message: "ToolFile must contain valid padded base64 and a matching byteLength.",
      });
    }
    // Preserve the parent's spelling for filesystem resolution: path.join and
    // Bun's realpath collapse symlink/.. lexically and can select the wrong parent.
    const parent = dirname(path);
    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => mkdtemp(`${parent}${sep}.executor-export-`),
        catch: () =>
          new LocalFileError({
            code: "file_write_failed",
            message:
              "Cannot create an export in the destination directory; the directory must already exist and be writable.",
          }),
      }),
      (temporaryDirectory) =>
        Effect.gen(function* () {
          const temporaryFile = `${temporaryDirectory}${sep}file`;
          yield* Effect.tryPromise({
            try: () => writeFile(temporaryFile, bytes, { flag: "wx", mode: 0o600 }),
            catch: () =>
              new LocalFileError({
                code: "file_write_failed",
                message: "Cannot write the exported file.",
              }),
          });
          // Publish complete bytes atomically without replacing existing files or
          // following a destination symlink. A rename would overwrite on POSIX.
          yield* Effect.tryPromise({
            try: () => link(temporaryFile, path),
            catch: (cause) =>
              hasFileSystemCode(cause) && cause.code === "EEXIST"
                ? new LocalFileError({
                    code: "file_exists",
                    message: "The destination already exists; choose a different file path.",
                  })
                : new LocalFileError({
                    code: "file_write_failed",
                    message: "Cannot publish the exported file at the destination.",
                  }),
          });
          return ToolResult.ok({ path, byteLength: bytes.length });
        }),
      (temporaryDirectory) =>
        Effect.tryPromise({
          try: () => rm(temporaryDirectory, { recursive: true, force: true }),
          catch: () =>
            new LocalFileError({
              code: "file_write_failed",
              message: "Cannot remove the temporary export file.",
            }),
        }).pipe(Effect.ignore),
    );
  }).pipe(
    Effect.catchTag("LocalFileError", ({ code, message }) =>
      Effect.succeed(ToolResult.fail({ code, message })),
    ),
  );

export const localFilesPlugin = definePlugin(() => ({
  id: "local-files" as const,
  storage: () => ({}),
  staticIntegrations: () => [
    {
      id: "files",
      kind: "executor",
      name: "Local Files",
      tools: [
        tool({
          name: "importLocal",
          description:
            "Read an absolute file path from this local daemon's disk as a base64 ToolFile (maximum 5 MiB). Files must be regular files readable by the daemon's OS user. No startup grants are required. File bytes enter the execution and may be included in outputs or traces; import only files you intend to disclose.",
          inputSchema,
          outputSchema,
          execute: ({ path }) => importLocalFile(path),
        }),
        tool({
          name: "exportLocal",
          description:
            "Save a ToolFile to an explicit absolute file path on this local daemon's disk (maximum 5 MiB). The parent directory must exist; existing destinations, including symlinks, are never overwritten. The file's name is metadata and is not used to choose the destination. Returns the saved path and byteLength.",
          inputSchema: exportInputSchema,
          outputSchema: exportOutputSchema,
          execute: exportLocalFile,
        }),
      ],
    },
  ],
}));
