import { constants } from "node:fs";
import { open, rm } from "node:fs/promises";
import { basename, extname, isAbsolute, sep } from "node:path";
import { Data, Effect, Exit, Schema } from "effect";
import { definePlugin, tool, ToolFileSchema, ToolResult } from "@executor-js/sdk";

export const LOCAL_FILE_MAX_BYTES = 5 * 1024 * 1024;

export const LOCAL_FILES_EXECUTE_SKILL_APPENDIX = [
  "## Local daemon file access",
  "",
  '- Call `tools.executor.files.importLocal({ path: "/absolute/path/file.pdf" })` to read a regular file up to 5 MiB and receive `{ ok: true, data: ToolFile }` (base64 bytes in `data.data`) or `{ ok: false, error }`.',
  '- Call `tools.executor.files.exportLocal({ file: toolFile, path: "/absolute/path/file.pdf" })` to save a `ToolFile` when the parent directory exists, without overwriting an existing destination, returning `{ ok: true, data: { path, byteLength } }` or `{ ok: false, error }`.',
  "- Both calls require the user's approval of the exact path, so the execution pauses once per call; resume it as instructed. Ask the user for the path instead of guessing, and batch the files you need into one execution.",
].join("\n");

class LocalFileError extends Data.TaggedError("LocalFileError")<{
  readonly code:
    | "invalid_file_path"
    | "not_regular_file"
    | "file_not_found"
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
const fileSystemCode = (cause: unknown): string | undefined =>
  hasFileSystemCode(cause) ? cause.code : undefined;

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
        catch: (cause) =>
          fileSystemCode(cause) === "ENOENT"
            ? new LocalFileError({
                code: "file_not_found",
                message: "No file exists at the given path.",
              })
            : new LocalFileError({
                code: "file_read_failed",
                message: "Cannot open the local file.",
              }),
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
    // O_CREAT|O_EXCL creates the destination only when nothing is there yet.
    // POSIX makes it fail with EEXIST when the final component is a symlink,
    // whatever it points at, so no file, directory, or link is ever replaced or
    // followed. The path is handed to the kernel unmodified so parent symlinks
    // and `..` keep filesystem semantics, and no temporary files or hard links
    // are needed in the user's directory.
    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600),
        catch: (cause) => {
          const code = fileSystemCode(cause);
          if (code === "EEXIST") {
            return new LocalFileError({
              code: "file_exists",
              message: "The destination already exists; choose a different file path.",
            });
          }
          return new LocalFileError({
            code: "file_write_failed",
            message:
              code === "ENOENT" || code === "ENOTDIR"
                ? "The destination's parent directory must already exist."
                : "Cannot create the destination file; the parent directory must be writable.",
          });
        },
      }),
      (handle) =>
        Effect.tryPromise({
          // Close inside the write step so an error deferred to close (network
          // filesystems) fails the export instead of being ignored.
          try: () => handle.writeFile(bytes).finally(() => handle.close()),
          catch: () =>
            new LocalFileError({
              code: "file_write_failed",
              message: "Cannot write the exported file.",
            }),
        }).pipe(Effect.as(ToolResult.ok({ path, byteLength: bytes.length }))),
      (handle, exit) =>
        Effect.tryPromise({
          try: () => handle.close(),
          catch: () =>
            new LocalFileError({
              code: "file_write_failed",
              message: "Cannot close the exported file.",
            }),
        }).pipe(
          Effect.ignore,
          // O_EXCL proved this call created the destination, so a failed or
          // interrupted write removes it rather than leaving partial bytes.
          Effect.andThen(
            Exit.isSuccess(exit)
              ? Effect.void
              : Effect.tryPromise({
                  try: () => rm(path, { force: true }),
                  catch: () =>
                    new LocalFileError({
                      code: "file_write_failed",
                      message: "Cannot remove the partial export.",
                    }),
                }).pipe(Effect.ignore),
          ),
        ),
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
            "Read an absolute file path from this local daemon's disk as a base64 ToolFile (maximum 5 MiB). Files must be regular files readable by the daemon's OS user. Each call pauses for the user's approval of the exact path unless a policy approves it. File bytes enter the execution and may be included in outputs or traces; import only files you intend to disclose.",
          inputSchema,
          outputSchema,
          // The daemon's OS user can read anything from SSH keys to the
          // executor's own secret store, and prompt-injected code has every
          // network tool available to exfiltrate it. Gate each read behind the
          // same approval boundary as the credential-touching core tools; the
          // approval prompt shows the requested path.
          annotations: {
            requiresApproval: true,
            approvalDescription:
              "Allow the agent to read this file from your computer? Its contents enter the execution and may appear in outputs or traces.",
          },
          execute: ({ path }) => importLocalFile(path),
        }),
        tool({
          name: "exportLocal",
          description:
            "Save a ToolFile to an explicit absolute file path on this local daemon's disk (maximum 5 MiB). The parent directory must exist; existing destinations, including symlinks, are never overwritten. The file's name is metadata and is not used to choose the destination. Each call pauses for the user's approval of the exact destination unless a policy approves it. Returns the saved path and byteLength.",
          inputSchema: exportInputSchema,
          outputSchema: exportOutputSchema,
          // Writes land wherever the daemon's OS user may create files
          // (shell profiles, launch agents, cron directories), so a new file is
          // a code-execution vector. Same gate as the other write operations.
          annotations: {
            requiresApproval: true,
            approvalDescription:
              "Allow the agent to create this file on your computer? Existing files are never overwritten.",
          },
          execute: exportLocalFile,
        }),
      ],
    },
  ],
}));
