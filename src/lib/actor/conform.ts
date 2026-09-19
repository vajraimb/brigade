/**
 * Machine-executable kernel dump.  Always prints brigade TSV
 * (`id<TAB>got`) for OTP_IDS.  If `escript` is on PATH, runs
 * erlang/conformance.erl (written against OTP 29.1) and diffs
 * byte-for-byte.
 *
 * Missing Erlang is a skip, not a fail — the sandbox cannot apt-get OTP.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OTP_IDS, otpDump } from "./semantics.ts";

export type DumpLine = { id: string; got: string; ok: boolean };

export function dumpOtp(): DumpLine[] {
  return otpDump();
}

export function formatTsv(rows: DumpLine[]): string {
  return rows.map((r) => `${r.id}\t${r.got}`).join("\n") + "\n";
}

function parseTsv(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line || line.startsWith("#") || line.startsWith("%%")) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    m.set(line.slice(0, tab), line.slice(tab + 1));
  }
  return m;
}

function main() {
  const rows = dumpOtp();
  const tsv = formatTsv(rows);
  const outDir = join(process.cwd(), "erlang");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "brigade.tsv"), tsv);
  process.stdout.write(tsv);

  let failed = 0;
  for (const r of rows) {
    if (!r.ok) {
      process.stderr.write(`FAIL ${r.id}: brigade case not ok (got ${r.got})\n`);
      failed++;
    }
  }

  const erl = spawnSync("escript", ["erlang/conformance.erl"], {
    encoding: "utf8",
    timeout: 20_000,
  });
  if (erl.error && (erl.error as NodeJS.ErrnoException).code === "ENOENT") {
    process.stderr.write(
      "skip: no escript on PATH — brigade TSV written; install OTP 29.1 to diff.\n",
    );
    process.exit(failed === 0 ? 0 : 1);
  }
  if (erl.status !== 0) {
    process.stderr.write(
      `escript failed (${erl.status}): ${erl.stderr || erl.stdout}\n`,
    );
    process.exit(1);
  }

  const gold = parseTsv(tsv);
  const them = parseTsv(erl.stdout);
  writeFileSync(join(outDir, "otp.tsv"), erl.stdout);

  const ids = OTP_IDS as readonly string[];
  for (const id of ids) {
    const a = gold.get(id);
    const b = them.get(id);
    if (a !== b) {
      process.stderr.write(
        `DIFF ${id}\n  brigade\t${a ?? "<missing>"}\n  otp    \t${b ?? "<missing>"}\n`,
      );
      failed++;
    }
  }
  for (const id of them.keys()) {
    if (!gold.has(id)) {
      process.stderr.write(`EXTRA otp ${id}\t${them.get(id)}\n`);
      failed++;
    }
  }

  if (failed === 0) {
    process.stderr.write(`ok: ${ids.length} cases byte-identical with OTP\n`);
    process.exit(0);
  }
  process.exit(1);
}

const isMain =
  typeof process.argv[1] === "string" &&
  /conform\.ts$/.test(process.argv[1].replaceAll("\\", "/"));

if (isMain) main();
