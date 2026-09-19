import assert from "node:assert/strict";
import { test } from "node:test";
import { CASES, runCase } from "./semantics.ts";

for (const c of CASES) {
  test(`${c.group} · ${c.primitive} · ${c.id}`, () => {
    const result = runCase(c);
    assert.equal(result.ok, true, `${c.id}: want ${result.want}, got ${result.got}`);
  });
}
