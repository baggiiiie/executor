# Executor accepts the wrong argument shape and forwards it upstream

## Issue

Post-body tools take a `body` object that becomes the HTTP JSON body. If you pass a string instead, executor does not reject it. It sends the string to the API, and you get a confusing upstream error instead of a local "wrong shape" failure.

Seen on GitHub Enterprise `issues.createComment`. Same pattern as other POST tools.

## Code passed in

```ts
await tools.github_v3_rest_api.org.illuminaenterpriseydai.issues.createComment({
  owner: "edgeos",
  repo: "helm-edgeos",
  issue_number: 1141,
  body: "Closing. This only adds timeout diagnostics and does not fix the hang.",
});
```

What the tool actually wants:

```ts
body: { body: "Closing. This only adds timeout diagnostics and does not fix the hang." }
```

## Error

```json
{
  "ok": false,
  "error": {
    "code": "upstream_http_error",
    "status": 400,
    "message": "Problems parsing JSON",
    "details": {
      "message": "Problems parsing JSON",
      "documentation_url": "https://docs.github.com/enterprise-server@3.17/rest/issues/comments#create-an-issue-comment",
      "status": "400"
    }
  }
}
```

GitHub got `"Closing. ..."` (a JSON string) instead of `{"body":"Closing. ..."}`.

## Suggested fix

Reject arguments that do not match the tool's input type and return `invalid_tool_arguments` before calling the API.
