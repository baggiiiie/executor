# [bug] Jira artifact shows “No open tickets” when the search returns results

## Executor version
Not recorded.

## How do you run Executor?
Not recorded.

## Operating system
Not recorded.

## Integration involved
Jira.

## What happened
The Jira search returned tickets, but the generated artifact showed “No open tickets.” It read `tickets.data.issues`, missing the tool-result envelope’s extra `data` field.

## What you expected
The artifact should show the returned tickets and display an error if the search fails.

## Steps to reproduce
1. Ask Executor to create an artifact showing your open Jira tickets.
2. Check whether the generated code reads `tickets.data?.issues ?? []`.
3. With that code, the artifact shows an empty state even when the search returns tickets.

## Diagnostics / logs
Changing the read to `tickets.data?.data?.issues ?? []` showed the tickets. The artifact also needs to handle `tickets.data.ok === false` rather than treating failures as empty results.

## Before you submit
- [ ] I searched the open issues for a duplicate.
- [x] I removed all keys, tokens, and credentials from this report.
