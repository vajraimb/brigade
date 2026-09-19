/**
 * Kernel dump. Always prints brigade TSV (`id<TAB>got<TAB>path`).
 * Three-state report on stderr:
 *   brigade-self     — this runtime
 *   otp-reference    — erlang/conformance.erl
 *   differential     — byte-identical got column
 * Missing Erlang is SKIP for the last two, not a silent pass.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OTP_IDS, OTP_PATH, otpDump } from "./semantics.ts";

export type DumpLine = { id: string; got: string; ok: boolean; path: string };

export function dumpOtp(): DumpLine[] {
  return otpDump().map((r) => ({
    ...r,
    path: OTP_PATH[r.id as keyof typeof OTP_PATH] ?? r.id,
  }));
}

export function formatTsv(
  rows: DumpLine[],
  header: { oracle: string },
): string {
  const lines = [
    `# brigade-self`,
    `# oracle: ${header.oracle}`,
    ...rows.map((r) => `${r.id}\t${r.got}\t${r.path}`),
  ];
  return lines.join("\n") + "\n";
}

function parseTsv(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line || line.startsWith("#") || line.startsWith("%%")) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const rest = line.slice(tab + 1);
    const tab2 = rest.indexOf("\t");
    const got = tab2 < 0 ? rest : rest.slice(0, tab2);
    m.set(line.slice(0, tab), got);
  }
  return m;
}

function report(name: string, status: string) {
  const pad = name.padEnd(16);
  process.stderr.write(`${pad} ${status}\n`);
}

function main() {
  const rows = dumpOtp();
  const tsv = formatTsv(rows, { oracle: "none" });
  const outDir = join(process.cwd(), "erlang");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "brigade.tsv"), tsv);
  process.stdout.write(tsv);

  let selfFail = 0;
  for (const r of rows) {
    if (!r.ok) {
      process.stderr.write(`FAIL ${r.id}: brigade case not ok (got ${r.got})\n`);
      selfFail++;
    }
  }
  report(
    "brigade-self",
    selfFail === 0 ? `${rows.length}/${rows.length} PASS` : `${rows.length - selfFail}/${rows.length} FAIL`,
  );

  const erl = spawnSync("escript", ["erlang/conformance.erl"], {
    encoding: "utf8",
    timeout: 20_000,
  });
  if (erl.error && (erl.error as NodeJS.ErrnoException).code === "ENOENT") {
    report("otp-reference", "SKIP (no escript)");
    report("differential", "SKIP");
    process.exit(selfFail === 0 ? 0 : 1);
  }
  if (erl.status !== 0) {
    report("otp-reference", `FAIL escript ${erl.status}`);
    report("differential", "SKIP");
    process.stderr.write(`${erl.stderr || erl.stdout}\n`);
    process.exit(1);
  }

  const them = parseTsv(erl.stdout);
  writeFileSync(
    join(outDir, "otp.tsv"),
    `# otp-reference\n# oracle: erl\n${erl.stdout}`,
  );
  report("otp-reference", `${them.size} lines`);

  const gold = parseTsv(tsv);
  let diffFail = 0;
  const ids = OTP_IDS as readonly string[];
  for (const id of ids) {
    const a = gold.get(id);
    const b = them.get(id);
    if (a !== b) {
      process.stderr.write(
        `DIFF ${id}\n  brigade\t${a ?? "<missing>"}\n  otp    \t${b ?? "<missing>"}\n`,
      );
      diffFail++;
    }
  }
  for (const id of them.keys()) {
    if (!gold.has(id)) {
      process.stderr.write(`EXTRA otp ${id}\t${them.get(id)}\n`);
      diffFail++;
    }
  }
  report(
    "differential",
    diffFail === 0 ? "PASS" : `${diffFail} DIFF`,
  );
  process.exit(selfFail === 0 && diffFail === 0 ? 0 : 1);
}

const isMain =
  typeof process.argv[1] === "string" &&
  /conform\.ts$/.test(process.argv[1].replaceAll("\\", "/"));

if (isMain) main();
