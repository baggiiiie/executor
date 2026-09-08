---
"@executor-js/execution": patch
"executor": patch
---

**Fix: clarify tool-result handling in artifact guidance.** Generated artifacts are instructed to read successful payloads from the tool-result envelope and display tool failures instead of misleading empty states. Query and pagination examples now demonstrate these checks.
