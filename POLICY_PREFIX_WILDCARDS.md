# Policy prefix wildcards

## Issue

Policies originally supported exact tool IDs and whole dot-separated wildcards only. This could
not group flat MCP tool names such as `delete_zone`:

- `cloudflare_mcp.delete_*` was rejected.
- `cloudflare_mcp.delete_` was accepted but matched only that exact name.

## Fix

A single trailing `*` is now allowed in the final tool-name segment.

| Entered pattern           | Stored pattern                | Matches                         |
| ------------------------- | ----------------------------- | ------------------------------- |
| `cloudflare_mcp.delete_*` | `cloudflare_mcp.*.*.delete_*` | `delete_zone`, `delete_account` |

Short patterns are expanded only when creating or editing a policy for a known connection-based
integration. Existing policies are not reinterpreted, and static tool patterns remain unchanged.

Leading and embedded wildcards such as `*foo`, `cloudflare_*`, and `delete_*_zone` remain invalid.
