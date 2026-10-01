import { AppProviderFailed, OAuthReconnectRequired } from "@executor-js/sdk";
import { Cause, Option, Schema } from "effect";
import { ProviderErrorNotice } from "@executor-js/ui/dashboard/provider-error-notice";
import { CompactFailure, ErrorNotice } from "@executor-js/ui/dashboard/error-notice";
import { UserFacingError } from "@executor-js/utils/user-facing-error";
import { ConnectionFailed, hasConnectionFailure } from "@executor-js/utils/connection-failure";
import { parseAppSearch } from "../../contracts/navigation.ts";
import type { ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { DashboardProvider } from "@executor-js/ui/dashboard/context";
import type {
  AppLinkProps,
  AccountLinkProps,
  FailureProps,
} from "@executor-js/ui/contracts/dashboard";
import { Alert } from "@executor-js/ui/components/alert";
import { Button } from "@executor-js/ui/components/button";
import { dashboardAtoms } from "../../contracts/dashboard-bindings.ts";
import { catalogIconDomainsAtom } from "@executor-js/ui/contracts/icons";
import { catalogAtom } from "../../contracts/api.ts";
import { useOrganizationRoute } from "./organization.tsx";
import { appError } from "../../contracts/apps.ts";
import type { HostedError } from "../../contracts/errors.ts";

const iconDomains = catalogIconDomainsAtom(catalogAtom);
/** Organization-aware atoms stay inside the hosted product. */
export function useDashboardAtoms() {
  return dashboardAtoms(useOrganizationRoute().organization);
}

const AppLink = ({ app, view, tool, profile, ...props }: AppLinkProps) => {
  const { slug: organizationSlug } = useOrganizationRoute();
  const location = useRouterState({ select: (state) => state.location });
  const current =
    location.pathname ===
    `/org/${encodeURIComponent(organizationSlug)}/apps/${encodeURIComponent(app)}`
      ? parseAppSearch(location.search).profile
      : undefined;
  return (
    <Link
      to="/org/$organizationSlug/apps/$appId"
      params={{ organizationSlug, appId: app }}
      search={{ view, tool, profile: profile ?? current }}
      {...props}
    />
  );
};
const AccountLink = ({ account, children, ...props }: AccountLinkProps) => {
  const { slug: organizationSlug } = useOrganizationRoute();
  return (
    <Link
      to="/org/$organizationSlug/accounts"
      params={{ organizationSlug }}
      search={{ account }}
      {...props}
    >
      {children}
    </Link>
  );
};
/** Hosted failures keep auth and transport details out of display components. */
export function HostedFailure({
  cause,
  context = "While completing this action in Executor.",
  ...props
}: Omit<FailureProps<HostedError>, "layout"> & {
  readonly context?: string;
  readonly layout?: "inline" | "panel" | "compact" | undefined;
  readonly retryStatus?: string;
}) {
  const { organization, slug: organizationSlug } = useOrganizationRoute();
  const location = useRouterState({ select: (state) => state.location });
  const profile = parseAppSearch(location.search).profile;
  // Only route identity enters copied prompts, never OAuth callback or arbitrary query values.
  const operationContext = `${context}\nOrganization: ${organizationSlug} (${organization})\nPage: ${location.pathname}${profile === undefined ? "" : `\nProfile: ${profile}`}`;
  const error = Cause.findErrorOption(cause);
  if (Option.isSome(error) && Schema.is(AppProviderFailed)(error.value))
    return <ProviderErrorNotice error={error.value} context={operationContext} {...props} />;
  if (Option.isSome(error) && UserFacingError.is(error.value))
    return (
      <ErrorNotice
        error={error.value}
        context={operationContext}
        action={
          Schema.is(OAuthReconnectRequired)(error.value) ? (
            <Button asChild size="sm">
              <Link
                to="/org/$organizationSlug/accounts"
                params={{ organizationSlug }}
                search={{ account: error.value.account }}
              >
                Reconnect this account
              </Link>
            </Button>
          ) : undefined
        }
        {...props}
      />
    );
  if (hasConnectionFailure(cause))
    return <ErrorNotice error={new ConnectionFailed()} context={operationContext} {...props} />;
  if (props.layout === "compact")
    return (
      <CompactFailure title="Unable to complete this request">
        <div>{appError(cause)}</div>
        {props.retry && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button variant="outline" size="xs" onClick={props.retry}>
              Retry
            </Button>
          </div>
        )}
      </CompactFailure>
    );
  return (
    <Alert className="error-state flex items-start gap-2.5 p-[15px] border border-border rounded-[7px] mb-4 [&_>_svg]:text-destructive [&_>_svg]:shrink-0 [&_>_svg]:mt-0.5 [&_>_div]:min-w-0 [&_>_div]:wrap-anywhere [&_>_div]:flex-1 [&_strong]:text-[13px] [&_strong]:font-medium [&_p]:text-[12px] [&_p]:text-muted-foreground [&_p]:mt-0.75 max-[740px]:flex-wrap max-[740px]:[&_>_div]:basis-[calc(100%_-_30px)] max-[740px]:[&_>_button]:ml-6.75">
      <div>
        <strong>Unable to complete this request</strong>
        <p>{appError(cause)}</p>
      </div>
      {props.retry && (
        <Button variant="outline" size="sm" onClick={props.retry}>
          Retry
        </Button>
      )}
    </Alert>
  );
}
/** Shared views bind independently of access checks and sidebar metadata. */
export function HostedDashboard({ children }: { readonly children: ReactNode }) {
  return (
    <DashboardProvider iconDomains={iconDomains} AppLink={AppLink} AccountLink={AccountLink}>
      {children}
    </DashboardProvider>
  );
}
