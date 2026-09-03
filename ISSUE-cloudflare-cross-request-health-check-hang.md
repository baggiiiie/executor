# Cloudflare cancels concurrent health-check waiters

## Summary

On the Cloudflare host, two overlapping health checks for the same connection
can cause one request to fail immediately. The failure is not a Workers CPU
limit (`1102`). Cloudflare reports that the request hung and would never
produce a response.

Executor deduplicates concurrent probes with a process-wide, per-connection
`Deferred`. The first request starts the upstream probe. A second request for
the same connection finds that `Deferred` and waits for it instead of starting
another probe. In a normal long-lived server process this is valid, but
Cloudflare Workers associates asynchronous I/O with the request that created
it. The second request has no request-owned I/O capable of waking it, so
workerd's hung-request detector cancels it.

## Production evidence

A live Worker tail captured two overlapping calls to the same health endpoint:

| Relative event                | Wall time | CPU time | Outcome          |
| ----------------------------- | --------: | -------: | ---------------- |
| First health check starts     |    918 ms |    63 ms | HTTP 200         |
| Duplicate starts 404 ms later |     85 ms |    46 ms | Worker exception |

The duplicate failed before the first request completed, with:

> The Workers runtime canceled this request because it detected that your
> Worker's code had hung and would never generate a response.

The same trace contradicts the earlier CPU-limit theory. Other concurrent
requests completed successfully with substantially more CPU:

| Request                 | Wall time | CPU time | Outcome  |
| ----------------------- | --------: | -------: | -------- |
| Health-check candidates |  2,423 ms |   535 ms | HTTP 200 |
| Integration tools       |  2,175 ms |   143 ms | HTTP 200 |
| Connection refresh      |  1,102 ms |   248 ms | HTTP 200 |

## Faulty flow

The health-probe gate is shared by every executor using the same root database
handle:

1. Request A creates a `Deferred`, stores it in `healthProbeInFlight`, and runs
   the probe on a detached fiber.
2. Request B finds the existing entry and calls `Deferred.await(existing)`.
3. The probe's network and database work belongs to request A.
4. Workerd sees request B suspended without request-owned pending I/O and
   cancels it as a request that can never complete.

The relevant implementation is in `packages/core/sdk/src/executor.ts`:

- `healthProbeGateByRootDb` makes the gate cross-executor and cross-request.
- The existing-entry path returns `Deferred.await(existing)`.
- The newly created probe runs via `Effect.forkDetach`.

## Reproduction

1. Deploy the Cloudflare host and configure an integration health check.
2. Start a health check for one connection.
3. Before it completes, start another health check for the same connection.
   Automatic revalidation and a manual check can also overlap.
4. Observe that one request succeeds while the waiter is canceled by workerd.

The failure requires both calls to reach the same warm isolate and overlap, so
it is intermittent.

## Corrective direction

Do not coordinate separate Worker requests with an in-memory `Deferred`.

For request-scoped runtimes, each request should run its own probe, or
coordination should move to a platform primitive whose completion is visible
to the waiting request. The simplest safe behavior is to disable cross-request
probe sharing on Workers while retaining it for conventional long-lived
processes.

The OAuth token-refresh gate uses the same root-database `Deferred` pattern and
should be audited for the same request-ownership failure.

### Acceptance criteria

- Two overlapping health checks for one connection both produce responses on
  Cloudflare.
- No request waits on asynchronous work created by another Worker request.
- Interrupting one caller does not corrupt the persisted health verdict.
- Conventional server hosts retain safe probe deduplication where supported.
- A Cloudflare-host regression test covers overlapping checks in one isolate.

## Separate performance finding

The health-check candidates endpoint is expensive, but it did not cause the
captured failure. Profiling the deployed Gmail OpenAPI document (about 385 KB,
75 operations, and 56 shared definitions) showed:

- full OpenAPI recompilation: about 76 ms locally;
- response-field projection: about 2.5 ms locally.

Candidate generation should use the already persisted operation bindings,
descriptions, response schemas, and definitions blob instead of recompiling the
full specification. This is a worthwhile CPU and latency improvement, but it
is separate from the cross-request hang.

The tools-list endpoint already projects schema columns out of its database
query, so it is not recompiling or projecting every tool schema.
