import { useEffect, useMemo, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  CASES,
  GROUP_LABEL,
  OTP_IDS,
  OTP_PATH,
  runCase,
  type SemCase,
  type SemGroup,
  type SemResult,
} from "@/lib/actor/semantics";
import { AMR_CASES } from "@/lib/amr/semantics";
import { cn } from "@/lib/utils";

const ALL_CASES: SemCase[] = [...AMR_CASES, ...CASES];

const GROUPS: SemGroup[] = [
  "amr",
  "genserver",
  "monitor",
  "combo",
  "link",
  "mailbox",
  "supervisor",
  "primitive",
];

function runMap() {
  const m = new Map<string, SemResult>();
  for (const c of ALL_CASES) m.set(c.id, runCase(c));
  return m;
}

export function SemanticsLab() {
  const [results, setResults] = useState(runMap);
  const [open, setOpen] = useState("amr-late-ack");

  useEffect(() => {
    const el = document.querySelector(`[data-case="${open}"]`);
    el?.scrollIntoView({ block: "center", behavior: "auto" });
  }, [open]);

  const passed = useMemo(
    () => [...results.values()].filter((r) => r.ok).length,
    [results],
  );
  const total = ALL_CASES.length;
  const allOk = passed === total;
  const kernelOk = OTP_IDS.every((id) => results.get(id)?.ok);

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <Layers />

      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3 sm:px-6">
        <p className="flex flex-wrap items-baseline gap-2 font-mono text-sm tabular-nums">
          <span className={allOk ? "text-ok" : "text-crash"}>
            {passed}/{total}
          </span>
          <span className="text-muted">语义对照</span>
          <span className={kernelOk ? "text-subtle" : "text-crash"}>
            kernel {OTP_IDS.length}
          </span>
        </p>
        <Button
          size="md"
          onClick={() => {
            setResults(runMap());
          }}
        >
          <RotateCcw />
          重跑
        </Button>
      </div>

      <ol className="mx-auto max-w-3xl pb-10">
        {GROUPS.map((g) => (
          <li key={g} className="border-b border-border">
            <p className="px-4 pt-4 pb-1 font-mono text-xs tracking-wide text-subtle uppercase sm:px-6">
              {GROUP_LABEL[g]}
            </p>
            <ul>
              {ALL_CASES.filter((c) => c.group === g).map((c) => {
                const r = results.get(c.id);
                const on = c.id === open;
                return (
                  <li key={c.id} data-case={c.id}>
                    <button
                      type="button"
                      aria-expanded={on}
                      onClick={() => setOpen(on ? "" : c.id)}
                      className={cn(
                        "flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left text-sm sm:px-6",
                        on ? "text-fg" : "text-muted hover:text-fg",
                      )}
                    >
                      <span
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          r?.ok ? "bg-ok" : "bg-crash",
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate">{c.title}</span>
                      <span className="shrink-0 font-mono text-xs text-subtle">
                        {c.primitive}
                      </span>
                    </button>
                    {on && r && <CaseBody case={c} result={r} />}
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Layers() {
  const rows = [
    {
      k: "Erlang",
      v: "spawn · send · receive · link · monitor · exit · supervisor · gen_server",
    },
    {
      k: "Effects",
      v: "receive / send / wait  —  perform → scan mailbox → continue k",
    },
    {
      k: "Runtime",
      v: "Pid · mailbox · link · monitor · alias · supervision — Switch ≠ link 图",
    },
  ] as const;
  return (
    <ol className="grid grid-cols-3 gap-px border-b border-border bg-border">
      {rows.map((row, i) => (
        <li key={row.k} className="bg-bg px-4 py-2.5 sm:px-6 sm:py-3">
          <p className="font-mono text-xs text-accent">
            {i + 1}. {row.k}
          </p>
          <p className="mt-1 hidden text-xs leading-snug text-muted sm:block">{row.v}</p>
        </li>
      ))}
    </ol>
  );
}

function CaseBody({
  case: c,
  result,
}: {
  case: SemCase;
  result: SemResult;
}) {
  return (
    <div className="px-4 pb-5 sm:px-6">
      {result.diagram && <LinkTrace d={result.diagram} />}
      {result.before && (
        <MailboxTrace
          before={result.before}
          after={result.after ?? []}
          taken={result.taken}
          step={result.step}
        />
      )}
      <p className="mt-4 text-sm leading-relaxed text-muted">{c.erlang}</p>
      {c.path ?? (c.id in OTP_PATH ? OTP_PATH[c.id as keyof typeof OTP_PATH] : null) ? (
        <p className="mt-2 font-mono text-xs text-subtle">
          {c.path ?? OTP_PATH[c.id as keyof typeof OTP_PATH]}
        </p>
      ) : null}
      <dl className="mt-4 grid gap-3 font-mono text-xs sm:grid-cols-2">
        <div>
          <dt className="text-subtle">want</dt>
          <dd className="mt-0.5 text-fg">{result.want}</dd>
        </div>
        <div>
          <dt className="text-subtle">got</dt>
          <dd className={result.ok ? "mt-0.5 text-ok" : "mt-0.5 text-crash"}>
            {result.got}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function LinkTrace({
  d,
}: {
  d: NonNullable<SemResult["diagram"]>;
}) {
  return (
    <div className="mt-3 flex items-stretch gap-2">
      <Node n={d.left} />
      <div className="flex min-w-0 flex-1 flex-col items-center justify-center px-2">
        <span className="h-px w-full bg-border-strong" />
        <p className="mt-1 whitespace-nowrap text-center font-mono text-xs text-crash">
          {d.signal}
        </p>
      </div>
      <Node n={d.right} />
    </div>
  );
}

function Node({
  n,
}: {
  n: { name: string; live: boolean; trap?: boolean };
}) {
  return (
    <div
      className={cn(
        "w-20 shrink-0 rounded-sm px-2 py-2 text-center",
        n.live ? "bg-surface-2" : "bg-crash/15",
      )}
    >
      <p className="font-mono text-xs text-fg">{n.name}</p>
      <p className={cn("mt-0.5 font-mono text-xs", n.live ? "text-ok" : "text-crash")}>
        {n.live ? "alive" : "dead"}
      </p>
      {n.trap ? <p className="mt-0.5 font-mono text-xs text-subtle">trap</p> : null}
    </div>
  );
}

function MailboxTrace({
  before,
  after,
  taken,
  step,
}: {
  before: string[];
  after: string[];
  taken?: string;
  step?: string;
}) {
  return (
    <div className="mt-4">
      <p className="font-mono text-xs text-subtle">mailbox</p>
      <Row tags={before} taken={taken} />
      <p
        className={cn(
          "mt-2 font-mono text-xs",
          taken ? "text-receive" : "text-crash",
        )}
      >
        {taken ? `receive ${taken}` : (step ?? "exit")}
      </p>
      <Row tags={after} />
    </div>
  );
}

function chipTone(tag: string, hit: boolean) {
  if (hit) return "bg-fg text-accent-fg";
  if (tag.startsWith("EXIT")) return "bg-crash/15 text-crash";
  if (tag.startsWith("DOWN")) return "bg-warn/15 text-warn";
  if (tag.startsWith("Call") || tag.startsWith("Reply") || tag.startsWith("Cast")) {
    return "bg-receive/15 text-receive";
  }
  return "bg-surface-2 text-muted";
}

function Row({ tags, taken }: { tags: string[]; taken?: string }) {
  let used = false;
  return (
    <ol className="mt-2 flex flex-wrap gap-1.5">
      {tags.map((tag, i) => {
        const hit = !used && taken != null && tag === taken;
        if (hit) used = true;
        return (
          <li
            key={`${tag}-${i}`}
            className={cn("rounded-sm px-2 py-1 font-mono text-xs", chipTone(tag, hit))}
          >
            {tag}
          </li>
        );
      })}
    </ol>
  );
}
