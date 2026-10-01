import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { nameConnectedAccount } from "../support/name-account.ts";
import { appsManifest } from "../support/apps-release.ts";
import { createProfile } from "../support/profiles.ts";
import { oauthRecoveryIssuer } from "../support/oauth-recovery-issuer.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

const Connection = Schema.Struct({
  id: Schema.String,
  state: Schema.Struct({
    status: Schema.Literal("completed"),
    account: Schema.Struct({ id: Schema.String, label: Schema.String }),
  }),
});

layer(HostedLive, { excludeTestServices: true })("OAuth account recovery", (it) => {
  it.effect(scenarios.oauthAccountRecovery.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          target = yield* Target;
        const issuer = yield* oauthRecoveryIssuer(target.metadata.origin);
        const prefix = `/api/organizations/${actors.organization.id}`;
        const app = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: "Sample mailboxes",
            files: [
              {
                path: "index.ts",
                content: `import { defineApp, defineProvider, oauth2, query, object, router } from "apps";
const service = defineProvider({ name: "Sample mail", auth: { oauth: oauth2({ discover: ${JSON.stringify(issuer.origin)}, scopes: ["read"] }) } });
export default defineApp({ accounts: { mailboxes: service.many() } }, async () => ({ tools: router({ status: query({ input: object({}) }, async () => "ready") }) }));`,
              },
              appsManifest,
            ],
          }),
        );
        const path = `${prefix}/apps/${app.id}`;
        const profile = yield* createProfile(actors.owner, path);
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
        for (const [label, expiresIn] of [
          ["Personal mailbox", 0],
          ["Work mailbox", 3600],
        ] as const) {
          yield* issuer.configure({ expiresIn });
          const connection = yield* body(
            Resource,
            yield* api.request(actors.owner, "POST", `${path}/connections`, {
              requirement: "mailboxes",
              profile: profile.id,
            }),
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
          expect(completed.state.account.label).toBe(label);
          accounts.push(completed.state.account.id);
        }
        const affected = accounts[0];
        expect(affected).toBeDefined();
        const failed = yield* api.request(
          actors.owner,
          "GET",
          `${path}/tools?profile=${profile.id}`,
        );
        expect(failed.status).toBe(409);
        expect(failed.body).toMatchObject({
          _tag: "OAuthReconnectRequired",
          account: affected,
          accountLabel: "Personal mailbox",
          providerName: "Sample mail",
        });
        yield* browser.use("Open the affected profile's Tools page", (page) =>
          page
            .goto(
              `/org/${actors.organization.slug}/apps/${app.id}?view=tools&profile=${profile.id}&code=PRIVATE_CALLBACK&state=PRIVATE_STATE`,
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
        expect(prompt).toContain(app.id);
        expect(prompt).toContain(profile.id);
        expect(prompt).toContain(actors.organization.slug);
        expect(prompt).not.toMatch(/Work mailbox|PRIVATE_CALLBACK|PRIVATE_STATE/);
        expect(
          yield* browser.use("Recovery targets only the failing account", (page) =>
            page.getByRole("link", { name: "Reconnect this account" }).getAttribute("href"),
          ),
        ).toBe(`/org/${actors.organization.slug}/accounts?account=${affected}`);
        yield* browser.checkpoint("Account-specific OAuth recovery");
        yield* browser.use("Open the exact account", (page) =>
          page
            .getByRole("link", { name: "Reconnect this account" })
            .click()
            .then(() => page.waitForURL(`**/accounts?account=${affected}`)),
        );
      }),
    ),
  );
});
