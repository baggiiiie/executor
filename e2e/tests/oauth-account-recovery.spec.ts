import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { McpClient } from "../support/mcp-client.ts";
import { nameConnectedAccount } from "../support/name-account.ts";
import { appsManifest } from "../support/apps-release.ts";
import { accountLinks, connectionsPath, linkAccount } from "../support/app-accounts.ts";
import { oauthRecoveryIssuer } from "../support/oauth-recovery-issuer.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

const Account = Schema.Struct({ id: Schema.String, label: Schema.String });
const Connection = Schema.Struct({
  id: Schema.String,
  state: Schema.Struct({
    status: Schema.Literal("completed"),
    account: Account,
  }),
});
const Detail = Schema.Struct({ account: Account });

/** An app whose user requirements link several accounts of one OAuth service, in each of `slots`. */
const mailboxes = (
  slots: ReadonlyArray<string> = ["mailboxes"],
  appSlots: ReadonlyArray<string> = [],
) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors,
      browser = yield* Browser,
      target = yield* Target;
    const issuer = yield* oauthRecoveryIssuer(target.metadata.origin);
    const prefix = `/api/organizations/${actors.organization.id}`;
    const app = yield* body(
      App,
      yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
        name: "Sample mailboxes",
        files: [
          {
            path: "index.ts",
            content: `import { defineApp, defineProvider, oauth2, query, object, router } from "apps";
const service = defineProvider({ name: "Sample mail", auth: { oauth: oauth2({ discover: ${JSON.stringify(issuer.origin)}, scopes: ["read"] }) } });
export default defineApp({ user: { accounts: { ${slots.map((slot) => `${slot}: service.many()`).join(", ")} } }, app: { accounts: { ${appSlots.map((slot) => `${slot}: service.many()`).join(", ")} } } }, async () => ({ tools: router({ status: query({ input: object({}) }, async () => "ready") }) }));`,
          },
          appsManifest,
        ],
      }),
    );
    const path = `${prefix}/apps/${app.id}`;
    const accounts: string[] = [];
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* api.request(actors.owner, "DELETE", path);
        for (const account of accounts)
          yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
      }).pipe(Effect.orDie),
    );
    yield* browser.omitNetworkTrace;
    yield* browser.login(actors.owner);
    /** Connect and name a new account whose token lasts `expiresIn` seconds and cannot be renewed. */
    const connect = (
      label: string,
      expiresIn: number,
      scope: "app" | "user" = "user",
      requirement = "mailboxes",
    ) =>
      Effect.gen(function* () {
        yield* issuer.configure({ expiresIn });
        const connection = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", connectionsPath(path, scope, requirement), {}),
        );
        yield* browser.use(`Connect ${label}`, (page) =>
          page
            .goto(`/org/${actors.organization.slug}/connections/${connection.id}`)
            .then(() =>
              page.getByRole("button", { name: "Connect Sample mail", exact: true }).click(),
            )
            .then(() => page.waitForURL(`**/apps/${app.id}?**`))
            .then(() => nameConnectedAccount(page, label)),
        );
        const completed = yield* body(
          Connection,
          yield* api.request(actors.owner, "GET", `${prefix}/connections/${connection.id}`),
        );
        const account = completed.state.account.id;
        accounts.push(account);
        const saved = yield* body(
          Detail,
          yield* api.request(actors.owner, "GET", `${prefix}/accounts/${account}`),
        );
        expect(saved.account.label).toBe(label);
        return account;
      });
    /** The browser can return to the app before the connection completes. */
    const completedConnection = (id: string) =>
      api.request(actors.owner, "GET", `${prefix}/connections/${id}`).pipe(
        Effect.flatMap((response) => body(Connection, response)),
        Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 50 }),
      );
    return { issuer, app, path, accounts, connect, completedConnection };
  });

layer(HostedLive, { excludeTestServices: true })("OAuth account recovery", (it) => {
  it.effect(scenarios.oauthAccountRecovery.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          target = yield* Target,
          mcp = yield* McpClient;
        const { issuer, app, path, accounts, connect, completedConnection } = yield* mailboxes();
        yield* connect("Personal mailbox", 1);
        yield* connect("Work mailbox", 3600);
        yield* connect("Archive mailbox", 1);
        // Let both one-second tokens expire.
        yield* Effect.sleep("1100 millis");
        const affected = accounts[0];
        expect(affected).toBeDefined();
        const selection = yield* accountLinks(actors.owner, path);
        expect(selection).toEqual(accounts.map((account) => ["mailboxes", account]));
        const archived = accounts[2];
        expect(archived).toBeDefined();
        const bothFailed = yield* api.request(actors.owner, "GET", `${path}/tools`);
        expect(bothFailed.status).toBe(409);
        expect(bothFailed.body).toMatchObject({
          _tag: "OAuthReconnectRequired",
          account: affected,
          accountLabel: "Personal mailbox",
          otherAccounts: [
            { account: archived, accountLabel: "Archive mailbox", providerName: "Sample mail" },
          ],
        });
        yield* browser.use("Open the Tools page with two failing accounts", (page) =>
          page
            .goto(`/org/${actors.organization.slug}/apps/${app.id}?view=tools`)
            .then(() =>
              page.getByRole("heading", { name: "2 accounts need to reconnect" }).waitFor(),
            ),
        );
        const bothPrompt = yield* browser.use("Copy the prompt naming both accounts", (page) =>
          page
            .context()
            .grantPermissions(["clipboard-read", "clipboard-write"])
            .then(() => page.getByRole("button", { name: "Copy fix prompt", exact: true }).click())
            .then(() => page.evaluate(() => navigator.clipboard.readText())),
        );
        expect(bothPrompt).toContain(`Account IDs: ${affected}, ${archived}`);
        expect(bothPrompt).toContain("Personal mailbox");
        expect(bothPrompt).toContain("Archive mailbox");
        expect(bothPrompt).not.toContain("Work mailbox");
        expect(
          yield* browser.use("Recovery opens the original app’s account requirements", (page) =>
            page.getByRole("link", { name: "Open Accounts", exact: true }).getAttribute("href"),
          ),
        ).toBe(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`);
        yield* browser.checkpoint("Both failing accounts listed");
        yield* issuer.configure({ expiresIn: 3600 });
        const archiveReconnect = yield* body(
          Schema.Struct({ id: Schema.String, url: Schema.String }),
          yield* api.request(actors.owner, "POST", connectionsPath(path, "user", "mailboxes"), {
            account: archived,
          }),
        );
        yield* browser.use("Reconnect the archive mailbox", (page) =>
          page
            .goto(archiveReconnect.url)
            .then(() =>
              page.getByRole("button", { name: "Reconnect Sample mail", exact: true }).click(),
            )
            .then(() => page.waitForURL(`**/apps/${app.id}?**`)),
        );
        yield* completedConnection(archiveReconnect.id);
        const failed = yield* api.request(actors.owner, "GET", `${path}/tools`);
        expect(failed.status).toBe(409);
        expect(failed.body).toMatchObject({
          _tag: "OAuthReconnectRequired",
          account: affected,
          accountLabel: "Personal mailbox",
          providerName: "Sample mail",
        });
        expect(failed.body).not.toHaveProperty("otherAccounts");
        const key = yield* body(
          Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "Account recovery",
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
            .pipe(Effect.orDie),
        );
        const client = yield* mcp.connect(key.key, "account-recovery", {
          organization: actors.organization.id,
        });
        const discovery = yield* client.use("An agent discovers the exact failing account", (mcp) =>
          mcp.callTool({
            name: "execute",
            arguments: {
              code: `return await tools.search({ namespace: ${JSON.stringify(app.slug)} });`,
            },
          }),
        );
        const unavailable = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            unavailableApps: Schema.Array(
              Schema.Struct({
                app: Schema.String,
                reason: Schema.String,
              }),
            ),
          }),
        )(discovery.structuredContent);
        const diagnostic = unavailable.unavailableApps.find((entry) => entry.app === app.id);
        expect(diagnostic?.reason).toContain(affected);
        expect(diagnostic?.reason).toContain("Personal mailbox");
        expect(diagnostic?.reason).toContain("appAccounts.userConnect");
        const agentError = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({
              title: Schema.String,
              detail: Schema.Struct({ label: Schema.String, value: Schema.String }),
            }),
          ),
        )(diagnostic?.reason ?? "");
        expect(agentError).toEqual({
          title: "An account needs to reconnect",
          detail: { label: "Account ID", value: affected },
        });
        expect(JSON.stringify(discovery.structuredContent)).not.toMatch(
          /Work mailbox|Archive mailbox|synthetic-original-secret/,
        );
        yield* browser.use("Open the affected app's Tools page", (page) =>
          page
            .goto(
              `/org/${actors.organization.slug}/apps/${app.id}?view=tools&code=PRIVATE_CALLBACK&state=PRIVATE_STATE`,
            )
            .then(() =>
              page.getByRole("heading", { name: "An account needs to reconnect" }).waitFor(),
            ),
        );
        expect(
          yield* browser.use("Read the named account error", (page) =>
            page.getByRole("alert").innerText(),
          ),
        ).toContain("Personal mailbox");
        const prompt = yield* browser.use("Copy the account-specific recovery prompt", (page) =>
          page
            .context()
            .grantPermissions(["clipboard-read", "clipboard-write"])
            .then(() => page.getByRole("button", { name: "Copy fix prompt", exact: true }).click())
            .then(() => page.evaluate(() => navigator.clipboard.readText())),
        );
        expect(prompt).toContain(`Account ID: ${affected}`);
        expect(prompt).toContain("Personal mailbox");
        expect(prompt).toContain(`App: ${app.id}`);
        expect(prompt).toContain(actors.organization.slug);
        expect(prompt).toContain("appAccounts.userConnect");
        expect(prompt).not.toMatch(/Work mailbox|Archive mailbox|PRIVATE_CALLBACK|PRIVATE_STATE/);
        expect(
          yield* browser.use("Recovery returns to the original app’s Accounts tab", (page) =>
            page.getByRole("link", { name: "Open Accounts" }).getAttribute("href"),
          ),
        ).toBe(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`);
        yield* browser.checkpoint("Account-specific OAuth recovery");
        yield* browser.use("Open the app’s account requirements", (page) =>
          page
            .getByRole("link", { name: "Open Accounts" })
            .click()
            .then(() => page.waitForURL(`**/apps/${app.id}?view=accounts`)),
        );
        const reconnectRequest = {
          account: affected,
        };
        const forbidden = yield* api.request(
          actors.member,
          "POST",
          connectionsPath(path, "user", "mailboxes"),
          reconnectRequest,
        );
        expect(forbidden.status).toBe(403);
        yield* issuer.configure({ expiresIn: 3600 });
        const reconnect = yield* body(
          Schema.Struct({ id: Schema.String, url: Schema.String }),
          yield* api.request(
            actors.owner,
            "POST",
            connectionsPath(path, "user", "mailboxes"),
            reconnectRequest,
          ),
        );
        expect(reconnect.url).toBe(
          `${target.metadata.origin}/org/${actors.organization.slug}/connections/${reconnect.id}`,
        );
        yield* browser.use("Complete the agent's browser reconnect link", (page) =>
          page
            .goto(reconnect.url)
            .then(() =>
              page.getByRole("button", { name: "Reconnect Sample mail", exact: true }).click(),
            )
            .then(() => page.waitForURL(`**/apps/${app.id}?**`)),
        );
        const completed = yield* completedConnection(reconnect.id);
        expect(completed.state.account.id).toBe(affected);
        expect(completed.state.account.label).toBe("Personal mailbox");
        const finalSelection = yield* accountLinks(actors.owner, path);
        expect(finalSelection).toEqual(selection);
        expect((yield* api.request(actors.owner, "GET", `${path}/tools`)).status).toBe(200);
        yield* browser.use("Verify tools after reconnecting the same account", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=tools`).then(() =>
            page
              .getByRole("button", { name: /status/ })
              .first()
              .waitFor(),
          ),
        );
        yield* browser.checkpoint("Tools restored with every account selection preserved");
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.oauthAccountRecoveryKept.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const { app, path, connect } = yield* mailboxes(["mailboxes"], ["shared"]);
        const lifetime = 15;
        yield* connect("Work mailbox", 3600);
        const personalConnectedAt = Date.now();
        const personal = yield* connect("Personal mailbox", lifetime);
        // Personal is linked in both scopes and must still be reported once as the user's account.
        yield* linkAccount(actors.owner, path, "shared", personal, "app");
        const archive = yield* connect("Archive mailbox", lifetime, "app", "shared");
        const archiveConnectedAt = Date.now();
        const tools = `${path}/tools`;
        expect((yield* api.request(actors.owner, "GET", tools)).status).toBe(200);
        const listedAt = Date.now();
        // The listing was kept while both tokens were still valid.
        expect(listedAt - personalConnectedAt).toBeLessThan(lifetime * 1000);
        yield* Effect.sleep(Math.max(0, archiveConnectedAt + (lifetime + 1) * 1000 - Date.now()));
        const expired = yield* api.request(actors.owner, "GET", tools);
        // Still inside the 30 s window in which the kept listing is served instead of re-evaluated.
        expect(Date.now() - listedAt).toBeLessThan(30_000);
        expect(expired.status).toBe(409);
        expect(expired.body).toMatchObject({
          _tag: "OAuthReconnectRequired",
          account: personal,
          accountLabel: "Personal mailbox",
          otherAccounts: [{ account: archive, appRequirement: "shared" }],
        });
        yield* browser.use("Open the Tools page after both sign-ins ended", (page) =>
          page
            .goto(`/org/${actors.organization.slug}/apps/${app.id}?view=tools`)
            .then(() =>
              page.getByRole("heading", { name: "2 accounts need to reconnect" }).waitFor(),
            ),
        );
        const prompt = yield* browser.use("Copy mixed-scope account recovery", (page) =>
          page
            .context()
            .grantPermissions(["clipboard-read", "clipboard-write"])
            .then(() => page.getByRole("button", { name: "Copy fix prompt", exact: true }).click())
            .then(() => page.evaluate(() => navigator.clipboard.readText())),
        );
        expect(prompt).toContain("someone who can edit the app");
        expect(prompt).toContain("appAccounts.appConnect");
        expect(prompt).not.toContain("Archive mailbox");
        expect(
          yield* browser.use("Only the user account offers a reconnect", (page) =>
            page.getByRole("link", { name: "Open Accounts", exact: true }).count(),
          ),
        ).toBe(1);
        yield* browser.checkpoint("Kept listing names both expired accounts");
      }),
    ),
  );
});
