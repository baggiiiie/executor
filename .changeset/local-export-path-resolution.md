---
"@executor-js/local": patch
"executor": patch
---

Create local exports directly with `O_CREAT|O_EXCL` instead of staging a temporary file and hard-linking it, so exports work on filesystems without hard-link support and leave no temporary entries in the destination directory. Parent-directory symlinks followed by `..` keep filesystem path semantics, directory-only destinations are rejected before writing, the decoded size limit is enforced independently of file metadata, a failed write removes the partial file, and a missing import path reports `file_not_found`.
