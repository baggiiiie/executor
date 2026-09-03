# Migrating a Personal (user) connection to Workspace (org) by direct DB edit

## Goal

Make existing OAuth/token connections visible to the machine identity MCP
clients use (a Cloudflare Access **service token**, which resolves to
`orgRole: "member"`). Personal (`owner: "user"`) connections are scoped to a
single human subject and are invisible to that service token; Workspace
(`owner: "org"`) connections are tenant-wide and visible to any member.

## What must move together (all consistently)

Ownership is encoded in several places. Flipping only some corrupts the
connection. For each connection:

1. `connection` row: `owner` `user`->`org`, `subject`->`''`, and rewrite the
   embedded owner segment `:user:`->`:org:` in `item_ids` and `refresh_item_id`.
2. `plugin_storage` secret rows (token, refresh, refresh:store-probe): same
   `owner`/`subject` change AND `:user:`->`:org:` in `key`.
3. `tool` rows (produced catalog, keyed by `connection`): `owner`/`subject`.
4. For OAuth connections, the OAuth client too: an org connection MUST use an
   org app (enforced in code). Move the `oauth_client` row + its
   `oauth-client:...:secret` plugin_storage row to org, and set each
   connection's `oauth_client_owner` to `org`.

## Gotchas that cost real debugging (symptom -> cause)

### 1. `CredentialWriteIncompleteError` / opaque `Internal tool error`

- **Cause A — BLOB vs TEXT key type.** Writing `plugin_storage.key` via
  `CAST(... AS BLOB)` stores it with blob storage class. The app reads keys as
  TEXT, and in SQLite a BLOB never equals a TEXT with identical bytes, so the
  secret lookup returns null. Fix: keep keys TEXT (`UPDATE ... SET key =
  CAST(key AS TEXT)`). (`connection.item_ids` is genuinely stored as blob, so
  that column is the exception — match each column's existing `typeof`.)

- **Cause B — dangling id pointer.** `oauth_client.client_secret_item_id` is a
  separate pointer to the secret's item id. Moving the secret's `key` to
  `:org:` without updating this pointer makes refresh look up the old `:user:`
  id and fail with "OAuth client credential write ... is incomplete". Fix:
  rewrite the pointer `:user:`->`:org:` too.

### 2. `org_write_denied` on explicit `connections.refresh`

The explicit `connections.refresh` tool is an admin-gated Workspace write, so a
member-role service token is denied — this is BY DESIGN. It does NOT block the
IMPLICIT refresh that a normal tool call triggers when the access token is
expired; that path is an exempt operational write and works for members. So do
not confuse the denied explicit-refresh with a broken connection.

## Verification (all passed, as the service token)

- `connections.list` shows the migrated connections as `owner: org`.
- GitHub (static header token, no refresh) `get_me` -> real data.
- Gmail (OAuth, expired token -> implicit refresh) `getProfile` -> real data
  for both accounts.

## Notes

- Encryption is a global key (scrypt(master, static salt)); no AAD. Moving a
  row's partition/key does not affect decryptability.
- Keep a reverse-SQL rollback per connection before applying.
