import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  FILES,
  SOURCES,
  fileForLoc,
  lineForLoc,
  type SourceFile,
} from "@/lib/kitchen/sources";

const KW =
  /^(let|rec|in|match|with|fun|function|functor|type|open|module|struct|end|if|then|else|and|when|perform|failwith|ignore|Some|None|true|false|mutable|of|begin|include|sig|val|exception|raise|try|as|to|downto|do|done|for|while|not|mod|lsl|lsr|asr|land|lor|lxor)$/;

type Props = {
  loc: string | null;
  processName?: string;
  file: SourceFile;
  onFile: (f: SourceFile) => void;
};

export function SourceView({ loc, file, onFile }: Props) {
  const src = SOURCES[file] ?? "";
  const lines = src.replace(/\n$/, "").split("\n");
  const mapped = loc ? fileForLoc(loc) : null;
  const hi = mapped === file ? lineForLoc(loc) : null;
  const scroller = useRef<HTMLPreElement>(null);
  const last = useRef<number | null>(null);

  useEffect(() => {
    if (hi == null || hi === last.current) return;
    last.current = hi;
    const el = scroller.current?.querySelector(`[data-line="${hi}"]`);
    el?.scrollIntoView({ block: "center" });
  }, [hi]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap gap-1 px-3 pt-2">
        {FILES.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => onFile(f)}
            className={cn(
              "rounded-sm px-2 py-1 font-mono text-xs transition-colors duration-150",
              file === f ? "bg-surface-2 text-fg" : "text-muted hover:text-fg",
            )}
          >
            {f}
          </button>
        ))}
      </div>
      <pre
        ref={scroller}
        className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-[11px] leading-5"
      >
        {lines.map((line, i) => {
          const n = i + 1;
          const on = hi === n;
          return (
            <div
              key={n}
              data-line={n}
              className={cn("flex gap-3 rounded-xs px-1", on && "bg-accent/10")}
            >
              <span className="w-7 shrink-0 select-none text-right text-subtle tabular-nums">
                {n}
              </span>
              <code className={cn("whitespace-pre text-muted", on && "text-fg")}>
                {tokenize(line)}
              </code>
            </div>
          );
        })}
      </pre>
    </div>
  );
}

function tokenize(line: string) {
  const parts: ReactNode[] = [];
  const re =
    /('(?:\\.|[^'])*')|("(?:\\.|[^"])*")|(\(\*.*?\*\))|(\b[A-Za-z_][A-Za-z0-9_']*\b)|(--[^\n]*)|([^A-Za-z_'"-]+)/g;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(line))) {
    const [raw, str1, str2, comment, ident, linec, other] = m;
    const key = `${i++}`;
    if (str1 || str2) {
      parts.push(
        <span key={key} className="text-ok">
          {raw}
        </span>,
      );
    } else if (comment || linec) {
      parts.push(
        <span key={key} className="text-subtle">
          {raw}
        </span>,
      );
    } else if (ident) {
      parts.push(
        <span key={key} className={KW.test(ident) ? "text-accent" : undefined}>
          {ident}
        </span>,
      );
    } else {
      parts.push(<span key={key}>{other ?? raw}</span>);
    }
  }
  return parts;
}
