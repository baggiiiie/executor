---
"@executor-js/local": patch
"@executor-js/execution": patch
"executor": patch
---

Add `executor.files.exportLocal` to save a base64 `ToolFile` at an explicit absolute path on the local daemon. Exports validate bytes, enforce a 5 MiB limit, require an existing parent directory, and never overwrite an existing file or symlink. Document the call and result in the execute skill.
