# Missing capability: a wait/sleep primitive for sandboxed executions

## Summary

Code run through the `execute` tool (QuickJS-wasm sandbox) has **no way to pause
for a duration**. There is no `setTimeout`, no `sleep` global, and no `sleep`/
`wait`/`delay` system tool. Any step that is timing-dependent — most
computer-use flows — has no clean way to wait for state to settle.

## Evidence

- The QuickJS sandbox injects only `__executor_log`, `__executor_invokeTool`,
  and result-capture globals (`packages/kernel/runtime-quickjs/src/index.ts`).
  No timer shim, no `queueMicrotask`.
- No `sleep`/`wait`/`delay` tool exists on the tool surface. Every `setTimeout`
  / `Effect.sleep` in the repo is host-side (runtime timeout enforcement,
  WorkOS-vault and OAuth backoff loops) — none is exposed into an execution.
- Attempting the obvious `await new Promise(r => setTimeout(r, 2000))` throws
  `Error: 'setTimeout' is not defined`.

## Why it matters

Computer-use is inherently timed: click -> the SPA re-renders -> only then is a
screenshot / accessibility-tree read valid. Without a wait, capturing state
immediately often returns the pre-render (stale) view.

## Current workaround

Burn wall-clock time with cheap no-op tool round-trips:

```js
for (let i = 0; i < 8; i++) { await tools.codex_computer_use.org.default.list_apps({}); }
const r = await tools.codex_computer_use.org.default.get_app_state({ app: "Arc", disableDiff: true });
```

Crude: the delay is imprecise (depends on per-call latency), wasteful, and
noisy in request ledgers.

## Proposed shape

A first-class system tool (fits the "all effects go through `tools.*`" model
better than a sandbox global):

```
tools.executor.sleep({ ms })
```

## Caveats to respect

- A raw sleep weakens the "executions are bounded / side-effect-free" property.
- It must be **capped** (e.g. <= remaining execution timeout) and
  **cancellable**, never an open-ended block.

## Related sandbox limitations (same design tradeoff)

- No `fetch` — all network egress is forced through `tools.*` (auditable).
- No `Buffer` / `atob` / `btoa` / `TextEncoder` / `TextDecoder` — byte handling
  is expected to go through `ToolFile`, not hand-rolled decoding.
