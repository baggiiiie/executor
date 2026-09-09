---
"@executor-js/local": patch
"executor": patch
---

Fix local exports through parent-directory symlinks followed by `..` by preserving filesystem path semantics when staging and publishing files. Reject directory-only destinations before writing and enforce the decoded size limit independently of file metadata.
