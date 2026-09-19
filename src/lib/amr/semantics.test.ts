import assert from "node:assert/strict";
import { test } from "node:test";
import { runCase } from "../actor/semantics.ts";
import { AMR_CASES } from "./semantics.ts";

test("AMR suite is 16 cases", () => {
  assert.equal(AMR_CASES.length, 16);
});

for (const c of AMR_CASES) {
  test(`${c.group} · ${c.primitive} · ${c.id}`, () => {
    const result = runCase(c);
    assert.equal(result.ok, true, `${c.id}: want ${result.want}, got ${result.got}`);
  });
}
