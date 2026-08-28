---
"@executor-js/execution": patch
"executor": patch
---

Allow coding agents to scope `tools.search` to the exact canonical address returned by `connections.list`, so account-specific requests discover tools from only the selected connection.
