# OAuth reconnect recovery

Recovery identifies failed accounts by ID and leaves healthy accounts unchanged.
Live evaluations and kept tool listings report each failed account once, even when
several requirements link it.

The shared template lives in `packages/sdk/src/contracts/oauth.ts`; the generic
wrapper lives in `packages/utils/src/user-facing-error.ts`. Hosted prompts add
organization, app and page identity. Local prompts add app identity. Arbitrary
query values and OAuth callbacks never enter copied prompts.

Profiles were removed upstream. Read the original app’s account requirements and
links, then use `appAccounts.userConnect` for the caller’s own linked accounts.
Pass the exact existing account ID to reconnect in place. For app-scoped accounts,
someone who can edit the app must use `appAccounts.appConnect`; callers receive
that instruction without a reconnect shortcut or the account’s private label.
Read the tool signature before calling it, give the browser link to the user,
and verify tool discovery afterward. Preserve account IDs and app links.

A missing refresh token can make an account expire repeatedly. Check the app’s
OAuth configuration for offline access when appropriate. Never ask for credentials
or OAuth callbacks in chat, replace an account, or switch authentication as a
workaround. Product authorization remains authoritative throughout renewal and
before a kept result is served.
