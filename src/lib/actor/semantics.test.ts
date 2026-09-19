import assert from "node:assert/strict";
import { test } from "node:test";
import { dumpOtp, formatTsv } from "./conform.ts";
import { CASES, OTP_IDS, runCase } from "./semantics.ts";

for (const c of CASES) {
  test(`${c.group} · ${c.primitive} · ${c.id}`, () => {
    const result = runCase(c);
    assert.equal(result.ok, true, `${c.id}: want ${result.want}, got ${result.got}`);
  });
}

test("OTP_IDS kernel dump is 20 lines, all ok", () => {
  const rows = dumpOtp();
  assert.equal(rows.length, 20);
  assert.equal(rows.length, OTP_IDS.length);
  for (const row of rows) {
    assert.equal(row.ok, true, `${row.id}: ${row.got}`);
  }
  const tsv = formatTsv(rows);
  const lines = tsv.trimEnd().split("\n");
  assert.equal(lines.length, 20);
  assert.match(lines[0]!, /^spawn\t/);
  assert.match(lines[19]!, /^gs-cast\t/);
});
