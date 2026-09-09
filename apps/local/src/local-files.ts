import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import { Data, Effect, Schema } from "effect";
import { definePlugin, tool, ToolFileSchema, ToolResult } from "@executor-js/sdk";

export const LOCAL_FILE_MAX_BYTES = 5 * 1024 * 1024;

class LocalFileError extends Data.TaggedError("LocalFileError")<{
  readonly code: "invalid_file_path" | "not_regular_file" | "file_too_large" | "file_read_failed";
  readonly message: string;
}> {}

const Input = Schema.Struct({ path: Schema.String });
const inputSchema = Schema.toStandardSchemaV1(Schema.toStandardJSONSchemaV1(Input));
const outputSchema = Schema.toStandardSchemaV1(Schema.toStandardJSONSchemaV1(ToolFileSchema));

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
      ],
    },
  ],
}));
