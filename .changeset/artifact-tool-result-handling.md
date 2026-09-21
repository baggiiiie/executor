---
"@executor-js/execution": patch
"executor": patch
---

**Fix: clarify tool-result handling in artifact guidance.** Generated artifacts are instructed to read successful payloads from the tool-result envelope and display rejected tool calls through TanStack's error state instead of misleading empty states. Query and pagination examples now demonstrate the transport contract.
