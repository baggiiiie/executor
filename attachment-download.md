# Native attachment downloads

## Task

Provide a native way for TUI and CLI clients to save binary tool results, such
as Gmail attachments, to a local file. These clients do not have a UI where
`emit(result.data)` can expose a clickable download.

## What was used

The executor code used to retrieve the attachment was:

```ts
const result =
  await tools.google_gmail.org.work.gmail.users.messages.attachments.get({
    userId: "me",
    messageId,
    id: attachmentId,
  });

if (result.ok) emit(result.data);
```

`result.data` was a `ToolFile`. Because the TUI did not expose the emitted
resource, the temporary executor output was read locally, its base64 PDF blob
was decoded, and the bytes were written to `20260828.pdf`. This was a client
workaround, not executor code.

## What is missing

Executor should provide a first-class file save/export operation that accepts a
`ToolFile` and writes it on the executor side. It should:

- accept a destination directory and optional filename;
- sanitize names, prevent path traversal, and avoid accidental overwrites;
- return the saved path, MIME type, byte length, and checksum;
- let the TUI print the resulting path;
- keep base64 decoding inside executor rather than requiring clients to decode
  attachment bytes.

`emit(result.data)` should remain the MCP/UI behavior, while TUI and CLI clients
should use the explicit save/export operation.
