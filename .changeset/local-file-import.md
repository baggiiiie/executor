---
"@executor-js/local": patch
"@executor-js/execution": patch
"executor": patch
---

Add `executor.files.importLocal` to the local daemon and document its call and result only in the local host's execute skill. Authenticated agents can import regular files readable by the daemon's OS user as base64 `ToolFile` values, up to 5 MiB, without startup configuration.
