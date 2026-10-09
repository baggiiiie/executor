# Improving the OAuthReconnectRequired fix prompt

Suggestions for the agent "fix prompt" that a user copies from the UI when a
connection fails with `OAuthReconnectRequired`.

## Where the template lives

The copyable prompt is assembled in two layers:

1. **Generic wrapper** — the `fixPrompt` getter in
   [`packages/utils/src/user-facing-error.ts`](../packages/utils/src/user-facing-error.ts)
   (around lines 158–170). Every error's copy prompt is built from this
   skeleton:
   - `"Diagnose and fix this problem in Executor. Use the current app context where relevant."`
   - `Error / Error code / Known cause [/ detail]`
   - `Investigation and recovery:` + the error's `recovery.instructions`
   - `"Make the smallest justified fix. Preserve existing account selections…"`
   - `"Verify the failed operation after the fix…"`

2. **OAuth-specific content** — `OAuthReconnectRequired` in
   [`packages/sdk/src/contracts/oauth.ts`](../packages/sdk/src/contracts/oauth.ts)
   (line ~845), whose `recovery.instructions` come from
   `reconnectInstructions()` (line ~838). That function produces the entire
   "Renew the OAuth grant for account ID … On hosted, call context.get({}) …
   Locally … accountConnect.issue …" body.

So the prompt a user copies is real template output, not hand-written. The
`Organization / Page / Profile` header some UIs show is a **UI-added preamble**,
not part of `fixPrompt`.

## Suggested changes (ordered by value)

### 1. Embed app, profile, and organization IDs — biggest gap

The template's `detail` only carries `Account ID`. The instructions repeatedly
say _"read the original profile"_ and _"the original app"_ but never give their
IDs. The only reason the UI prompt shows them is the UI preamble, which is not
part of `fixPrompt`. When the prompt is pasted into a different agent session,
that context is gone and `"Use the current app context where relevant"` becomes
a dangling reference. Live, this forces the agent to search + read profiles to
map account → app/profile itself.

Fix: carry `app`, `profile`, and `organization` on the error fields and surface
them in the prompt (either expand `detail` to allow multiple safe values, or add
them into the instructions text). These are IDs, not secrets, so they are safe
under the "safe values only" rule.

Scope: touches the error's schema fields and the few
`new OAuthReconnectRequired({ ... })` construction sites. Larger than the others;
scope separately as a contract change.

### 2. Soften "Make the smallest justified fix"

This phrasing frames every error as a code bug. For `OAuthReconnectRequired`
there is nothing to fix in source — the grant is dead and the only remedy is an
operational reconnect. A literal-minded agent can waste effort hunting for a
code change.

Suggested wording: _"Make the smallest change that resolves it. This may be an
operational reconnect rather than a code edit."_

Scope: one-line edit in `user-facing-error.ts`.

### 3. Warn that Executor's tools are namespaced

The instructions say `call context.get({})`, `profiles.get`, `accounts.connect`
as if top-level. They are actually under
`tools.executor.profiles["ins_…"].<tool>`. A first call to
`tools.executor.context.get` fails with `UnknownTool` until the agent searches.

Suggested clause: _"These tools are exposed under tools.executor.profiles[…];
use search to resolve the exact path before calling."_ The existing "read each
tool's signature first" line is close but does not flag the namespacing.

Scope: small addition to `reconnectInstructions()` in `oauth.ts`.

### 4. Add an explicit "confirm which grant is dead" step for multi-account profiles

The single-account branch is well targeted. But where a profile selects several
accounts (`cardinality: many`), add: _"Before issuing any reconnect, confirm via
accounts.connection which grants actually fail (expect invalid_grant); leave
healthy accounts untouched."_ The error already knows the failed `account` +
`otherAccounts`, so this is cheap insurance against reconnecting a working
account.

Scope: small addition to `reconnectInstructions()` in `oauth.ts`.

### 5. Drop or qualify "Use the current app context where relevant"

A copied prompt frequently has no shared context. Qualify it, and pair with #1 so
the IDs travel with the prompt.

Scope: one-line edit in `user-facing-error.ts`.

## Rollout order

Start with #2, #3, #4 — low-risk text changes. Scope #1 separately as a contract
change (new error fields + construction sites). #5 pairs with #1.
