import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlAuditStore, makeAuditEvent, sha256 } from "../src/audit.js";
describe("JsonlAuditStore", () => {
  it("appends one JSON line per event and creates missing directories", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "audit-")), "nested", "audit.jsonl");
    const store = new JsonlAuditStore(path);
    await store.append(makeAuditEvent({ event: "a", repository: "o/r", decision: "completed" }));
    await store.append(makeAuditEvent({ event: "b", repository: "o/r", decision: "rejected", reason: "why" }));
    const lines = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.map((l) => l.event)).toEqual(["a", "b"]);
    expect(lines[0].schemaVersion).toBe(1);
  });
  it("hashes deterministically", () => {
    expect(sha256("x")).toBe(sha256("x"));
    expect(sha256("x")).not.toBe(sha256("y"));
  });
});
