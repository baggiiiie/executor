---
"@executor-js/local": patch
"executor": patch
---

Gate `executor.files.importLocal` and `executor.files.exportLocal` behind the same `requiresApproval` boundary as the credential- and policy-writing core tools. Each call pauses the execution with a prompt naming the exact path until `resume` accepts it; an `approve` policy on `executor.files.*` restores unattended access, and a `block` policy disables the tools.
