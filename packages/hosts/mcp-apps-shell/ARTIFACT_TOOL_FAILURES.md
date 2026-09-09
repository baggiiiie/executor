# Artifact tool-call failures

Artifact code makes one tool call through `execute-action`. The execution result wraps the tool value under `structuredContent.result`.

Tool failures use the value shape `{ ok: false, error }`. Treating that shape as successful query data can make a broken or stale connection appear as an empty result with a recent sync time.

The shell therefore rejects `ok: false` values after unwrapping them. React Query then exposes the failure to the artifact, which renders its error state instead of an empty state.
