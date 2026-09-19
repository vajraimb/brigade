import { useMemo, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  CASES,
  GROUP_LABEL,
  runCase,
  type SemCase,
  type SemGroup,
  type SemResult,
} from "@/lib/actor/semantics";
import { cn } from "@/lib/utils";

const GROUPS: SemGroup[] = ["mailbox", "primitive", "link", "supervisor"];

function runMap() {
  const m = new Map<string, SemResult>();
  for (const c of CASES) m.set(c.id, runCase(c));
  return m;
}

export function SemanticsLab() {
  const [results, setResults] = useState(runMap);
  const [open, setOpen] = useState("selective-receive");

  const passed = useMemo(
    () => [...results.values()].filter((r) => r.ok).length,
    [results],
  );
  const total = CASES.length;
  const allOk = passed === total;

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <Layers />

      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3 sm:px-6">
        <p className="flex items-baseline gap-2 font-mono text-sm tabular-nums">
          <span className={allOk ? "text-ok" : "text-crash"}>
            {passed}/{total}
          </span>
          <span className="text-muted">OTP 语义对照</span>
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
              {CASES.filter((c) => c.group === g).map((c) => {
                const r = results.get(c.id);
                const on = c.id === open;
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      aria-expanded={on}
                      onClick={() => setOpen(on ? "" : c.id)}
                      className={cn(
                        "flex h-12 w-full items-center gap-3 px-4 text-left text-sm sm:px-6",
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
      v: "spawn  ·  send  ·  receive  ·  link  ·  exit  ·  supervisor",
    },
    {
      k: "Effects",
      v: "perform Receive  →  handler 扫邮箱，continue 续体",
    },
    {
      k: "Eio",
      v: "Fiber.fork  ·  Switch  ·  Clock  — 藏在 handler 下面",
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
      {result.before && (
        <MailboxTrace
          before={result.before}
          after={result.after ?? []}
          taken={result.taken}
        />
      )}
      <p className="mt-4 text-sm leading-relaxed text-muted">{c.erlang}</p>
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

function MailboxTrace({
  before,
  after,
  taken,
}: {
  before: string[];
  after: string[];
  taken?: string;
}) {
  return (
    <div className="mt-4">
      <p className="font-mono text-xs text-subtle">mailbox</p>
      <Row tags={before} taken={taken} />
      {taken ? (
        <p className="mt-2 font-mono text-xs text-receive">receive {taken}</p>
      ) : (
        <p className="mt-2 font-mono text-xs text-crash">exit</p>
      )}
      <Row tags={after} />
    </div>
  );
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
            className={cn(
              "rounded-sm px-2 py-1 font-mono text-xs",
              hit ? "bg-fg text-accent-fg" : "bg-surface-2 text-muted",
            )}
          >
            {tag}
          </li>
        );
      })}
    </ol>
  );
}
