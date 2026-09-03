# Artifact tools — agent triage

Notes from a Cursor session that created and edited a live artifact via Executor MCP (`create-artifact`, `edit-artifact`, `list-artifacts`, `show-artifact`). The host could not display MCP Apps.

## 1. `show-artifact` returns no source to the model

**Issue.** The create-artifact skill says: if you do not have the stored source, call `show-artifact` and edit from what it returns. The tool result the model saw was only a save confirmation and a localhost artifact URL. No component source.

**Repro.**

1. Create an artifact with `create-artifact`.
2. In the same or a later turn, call `show-artifact` with that `artifactId`.
3. Read the tool result the model receives (not the MCP App iframe).

**Check.** The result text has no stored JSX/`App` source. The model cannot use it as the basis for `edit-artifact`.

## 2. Failed `edit-artifact` claims source is in `structuredContent.code`, but the model does not see it

**Issue.** `edit-artifact` is atomic: if any patch fails, nothing is saved. On an ambiguous `oldText`, the error says the current source is in `structuredContent.code` and to rebuild the retry from that. The model only received the error sentence, not the file.

**Repro.**

1. Create an artifact whose source contains the same short closer twice (e.g. `</div>\n  );\n}` on a helper and on `App`).
2. Call `edit-artifact` with a four-edit batch; make the last `oldText` that shared closer.
3. Read the tool result the model receives.

**Check.** The batch is rejected (`appears 2 times`, `Nothing was changed`). The result mentions `structuredContent.code` but does not include the current source in the text the model can read. The model has to retry from memory.

## 3. Ambiguous-edit error does not show where the matches are

**Issue.** Same failure as (2). The error reports that `oldText` appears N times and does not show the surrounding lines or line numbers of each hit.

**Repro.** Same as (2).

**Check.** The model cannot tell which occurrence to disambiguate (helper vs `App` closer) without guessing more context.

## 4. Model cannot see the rendered artifact

**Issue.** After every create/edit, the tool says this client cannot display MCP Apps and to give the user the localhost URL. The model gets no render, screenshot, or smoke result. Compile/accept is the only signal.

**Repro.**

1. From Cursor (or any host that cannot render MCP Apps), `create-artifact` or `edit-artifact`.
2. Change something user-visible (tooltip, click-to-expand, filter).
3. Inspect what the model receives.

**Check.** Result is a URL only. No image, DOM snapshot, or pass/fail of the live UI. Hover/click behavior cannot be verified by the model.
