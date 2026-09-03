# Jira artifact: “No open tickets” result

Date: 2026-09-08

## Issue encountered

The Jira search returned 19 issues assigned to the current user that were not in the Done status category. The artifact nevertheless displayed `No open tickets`.

The artifact code read the issues from:

```js
const issues = tickets.data?.issues ?? [];
```

The query result was wrapped in the tool response envelope, so the issues were under `tickets.data.data.issues`. The expression above therefore evaluated to an empty array. That empty array caused the artifact to render its `No open tickets` empty state.

The correction was:

```js
const issues = tickets.data?.data?.issues ?? [];
```

## Code passed to `executor-create-artifact`

The following is the artifact code passed verbatim:

```jsx
function App() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const tickets = useQuery(
    tools.jira_illumina.issueSearch.searchForIssuesUsingJqlPost.queryOptions({
      body: {
        jql: "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC",
        fields: ["summary", "status", "priority", "project", "updated", "issuetype"],
        maxResults: 100,
        startAt: 0,
        validateQuery: true,
      },
    }),
  );

  const issues = tickets.data?.issues ?? [];
  const statuses = Array.from(new Set(issues.map((issue) => issue.fields?.status?.name).filter(Boolean)));
  const normalizedSearch = search.trim().toLowerCase();
  const filteredIssues = issues.filter((issue) => {
    const fields = issue.fields ?? {};
    const matchesSearch = !normalizedSearch || [
      issue.key,
      fields.summary,
      fields.project?.name,
      fields.project?.key,
      fields.status?.name,
      fields.issuetype?.name,
    ].some((value) => String(value ?? "").toLowerCase().includes(normalizedSearch));
    const matchesStatus = statusFilter === "all" || fields.status?.name === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const inProgressCount = issues.filter((issue) => issue.fields?.status?.statusCategory?.key === "indeterminate").length;
  const toDoCount = issues.filter((issue) => issue.fields?.status?.statusCategory?.key === "new").length;

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex shrink-0 flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Jira workload</div>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">My tickets</h1>
          <p className="mt-1 text-sm text-muted-foreground">Assigned to you and not in Done.</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative sm:w-64">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search tickets" className="h-9 pl-8" />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-9 sm:w-40">
              <SelectValue placeholder="Filter status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {statuses.map((status) => <SelectItem key={status} value={status}>{status}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => tickets.refetch()} disabled={tickets.isFetching}>
            {tickets.isFetching ? "Refreshing..." : "Refresh"}
          </Button>
        </div>
      </div>

      <div className="grid shrink-0 grid-cols-2 gap-3 md:grid-cols-3">
        <div className="rounded-lg border border-border p-4">
          <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Open tickets</div>
          <div className="mt-2 text-2xl font-medium tabular-nums">{issues.length.toLocaleString()}</div>
        </div>
        <div className="rounded-lg border border-border p-4">
          <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">In progress</div>
          <div className="mt-2 text-2xl font-medium tabular-nums">{inProgressCount.toLocaleString()}</div>
        </div>
        <div className="col-span-2 rounded-lg border border-border p-4 md:col-span-1">
          <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">To do</div>
          <div className="mt-2 text-2xl font-medium tabular-nums">{toDoCount.toLocaleString()}</div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border">
        {tickets.isLoading ? (
          <ArtifactLoading variant="table" rows={8} />
        ) : tickets.error && tickets.data === undefined ? (
          <ArtifactError error={tickets.error} onRetry={tickets.refetch} />
        ) : filteredIssues.length === 0 ? (
          <ArtifactEmpty title={issues.length === 0 ? "No open tickets" : "No matching tickets"} />
        ) : (
          <table className="w-full table-fixed">
            <thead className="sticky top-0 z-10 border-b border-border bg-background">
              <tr>
                <th className="w-32 px-4 py-3 text-left text-xs font-medium">Ticket</th>
                <th className="px-4 py-3 text-left text-xs font-medium">Summary</th>
                <th className="w-32 px-4 py-3 text-left text-xs font-medium">Status</th>
                <th className="hidden w-28 px-4 py-3 text-left text-xs font-medium md:table-cell">Priority</th>
                <th className="hidden w-32 px-4 py-3 text-left text-xs font-medium lg:table-cell">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredIssues.map((issue) => {
                const fields = issue.fields ?? {};
                const status = fields.status ?? {};
                const priority = fields.priority ?? {};
                const updated = fields.updated ? new Date(fields.updated).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";
                return (
                  <tr key={issue.key} className="align-top">
                    <td className="px-4 py-3">
                      <a href={`https://jira.illumina.com/browse/${issue.key}`} target="_blank" rel="noreferrer" className="font-mono text-xs text-foreground underline-offset-4 hover:underline">{issue.key}</a>
                    </td>
                    <td className="px-4 py-3">
                      <div className="truncate text-sm" title={fields.summary}>{fields.summary || "Untitled ticket"}</div>
                      <div className="mt-1 truncate text-xs text-muted-foreground">{fields.issuetype?.name || "Issue"} · {fields.project?.key || fields.project?.name || "—"}</div>
                    </td>
                    <td className="px-4 py-3"><Badge variant="outline">{status.name || "Unknown"}</Badge></td>
                    <td className="hidden px-4 py-3 text-sm text-muted-foreground md:table-cell">{priority.name || "Not prioritized"}</td>
                    <td className="hidden px-4 py-3 font-mono text-xs text-muted-foreground lg:table-cell">{updated}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
```
