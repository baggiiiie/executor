import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Mcp, Target } from "../src/services";

scenario(
  "Cloud · local disk tools are neither advertised nor callable",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const session = mcp.session(identity, { artifacts: false });

    const skill = yield* session.call("skills", { name: "execute" });
    expect(skill.ok).toBe(true);
    expect(skill.text).not.toContain("executor.files.importLocal");
    expect(skill.text).not.toContain("executor.files.exportLocal");

    const result = yield* session.call("execute", {
      code: `
        const matches = await tools.search({ query: "local file import export", limit: 50 });
        const imported = await tools.executor.files.importLocal({ path: "/etc/passwd" });
        const exported = await tools.executor.files.exportLocal({
          path: "/tmp/executor-cloud-boundary",
          file: {
            _tag: "ToolFile",
            mimeType: "application/octet-stream",
            encoding: "base64",
            data: "",
            byteLength: 0,
          },
        });
        return {
          discovered: matches.items.some((item) =>
            item.path === "executor.files.importLocal" ||
            item.path === "executor.files.exportLocal"
          ),
          importError: imported.ok ? null : imported.error.code,
          exportError: exported.ok ? null : exported.error.code,
        };
      `,
    });

    expect(result.ok, `execute completed (got: ${result.text.slice(0, 400)})`).toBe(true);
    expect(result.raw).toMatchObject({
      structuredContent: {
        result: {
          discovered: false,
          importError: "tool_not_found",
          exportError: "tool_not_found",
        },
      },
    });
  }),
);
