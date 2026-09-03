# Native MCP OAuth on the Cloudflare host ("log in as me")

## The problem it solves

Today, when an MCP client (Cursor, ChatGPT) talks to the Cloudflare host's
`/mcp`, it authenticates as a **machine** — a Cloudflare Access service token —
not as the human. That service token is a different principal than your web-UI
login (its `accountId` is the token's `common_name`, with no email/sub). Because
connections are owner-scoped, your **Personal** (`owner: "user"`) connections
are invisible to that machine identity — which is why we had to convert them to
**Workspace** (`owner: "org"`) to make them usable.

**"Log in as me"** means the MCP client proves it is acting as **you** (your
real identity), so executor sees your human account on every request — the same
identity you have in the web UI.

## What building it concretely means

`executor.yingchao.dev/mcp` currently advertises no OAuth server (its
`/.well-known/oauth-protected-resource` returns `authorization_servers: []`).
That empty seam is exactly why we needed the Cloudflare MCP Portal as a bridge.

Native MCP OAuth means implementing, in the Cloudflare host, so that:

1. An MCP client hits `/mcp` and gets a proper OAuth challenge.
2. It opens a browser and you **log in through Cloudflare Access** (real identity).
3. Executor mints a token bound to **your human account** (email/sub), not a
   machine token.
4. Every tool call arrives as *you* — so your **Personal** connections just
   work: no sharing, no Workspace conversion, no service token.

## Why it is the "correct" answer

- It is already how the other hosts work: **self-host** via Better Auth's
  `mcp()` plugin; **cloud** via WorkOS/AuthKit. Only the Cloudflare host left the
  MCP-OAuth seam empty and leaned on Cloudflare Access instead. It is a known,
  solved pattern in this codebase — just not wired up for Cloudflare.
- It removes every workaround we accumulated: no portal, no service token in a
  plaintext config file, no per-client redirect-URI allowlisting, no
  Personal->Workspace migration, no "everyone shares one identity."

## The tradeoff (why we did not do it)

It is a **code change** to the Cloudflare host — add the discovery docs plus
`/authorize` / `/token` / `/register` (or delegate to an external OIDC provider
with dynamic client registration) — and reconcile it with Cloudflare Access
sitting in front (the OAuth endpoints and `/mcp` would need to be carved out of
the Access browser-login gate). That is real work. The no-code-change path we
took instead paid for itself with the config-heavy portal + Workspace-ownership
route.

## Nuance for a solo setup

For a single-user instance, "log in as me" and "share as Workspace" are nearly
equivalent in practice — there is only one human, and Workspace-owned
connections (what we did) work fine. "Log in as me" matters most with
**multiple users**, where each person's Personal connections should stay private
to them while MCP clients still act on their behalf.

## Summary

Architecturally cleaner, matches the pattern the other hosts already use, and
would have avoided the whole portal / service-token / Workspace dance — but it
is a code project, not a config tweak.
