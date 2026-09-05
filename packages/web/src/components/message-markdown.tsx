import { Check, Copy } from "lucide-react";
import { Children, isValidElement, useEffect, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { rehypeHighlight } from "../lib/code-highlighter";

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!isValidElement<{ children?: ReactNode }>(node)) return "";
  return Children.toArray(node.props.children).map(textContent).join("");
}

type CodeBlockProps = ComponentPropsWithoutRef<"pre"> & {
  "data-language"?: string;
  node?: unknown;
};

function CodeBlock({ children, className, "data-language": language, node: _node, ...properties }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const code = Children.toArray(children).map(textContent).join("");

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="group/code my-2 max-w-full overflow-hidden rounded-md border border-[var(--border)] bg-[var(--panel-muted)]">
      <div className="flex min-h-8 items-center justify-between border-b border-[var(--border-subtle)] px-2.5">
        <span className="font-mono text-[0.625rem] uppercase tracking-wide text-[var(--muted)]">
          {language === "plaintext" ? "Code" : language}
        </span>
        <button
          type="button"
          onClick={copyCode}
          className="inline-flex min-h-7 items-center gap-1 rounded px-1.5 text-[0.625rem] font-medium text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
          aria-label={copied ? "Code copied" : "Copy code"}
        >
          {copied ? <Check aria-hidden="true" size={13} /> : <Copy aria-hidden="true" size={13} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre
        {...properties}
        data-language={language}
        className={`${className ?? ""} max-w-full overflow-x-auto p-3 font-mono text-xs leading-5 [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-[inherit]`}
      >
        {children}
      </pre>
    </div>
  );
}

export function MessageMarkdown({ body }: { body: string }) {
  return (
    <div className="message-markdown break-words text-sm leading-6">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        skipHtml
        components={{
          a: ({ children, ...properties }) => (
            <a
              {...properties}
              target="_blank"
              rel="noreferrer noopener"
              className="text-[var(--accent)] underline underline-offset-2"
            >
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-[var(--border)] pl-3 text-[var(--muted)]">
              {children}
            </blockquote>
          ),
          code: ({ children, className }) => (
            <code className={`${className ?? ""} rounded bg-[var(--panel-muted)] px-1 py-0.5 font-mono text-[0.85em]`}>
              {children}
            </code>
          ),
          h1: ({ children }) => <h1 className="mt-4 mb-2 text-lg font-semibold first:mt-0">{children}</h1>,
          h2: ({ children }) => <h2 className="mt-4 mb-2 text-base font-semibold first:mt-0">{children}</h2>,
          h3: ({ children }) => <h3 className="mt-3 mb-1 text-sm font-semibold first:mt-0">{children}</h3>,
          hr: () => <hr className="my-3 border-[var(--border)]" />,
          img: ({ alt }) => (
            <span className="rounded bg-[var(--panel-muted)] px-1.5 py-0.5 text-xs text-[var(--muted)]">
              Image: {alt || "attachment"}
            </span>
          ),
          li: ({ children }) => <li className="my-0.5 pl-0.5">{children}</li>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-0.5 pl-5">{children}</ol>,
          p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
          pre: CodeBlock,
          table: ({ children }) => (
            <div className="my-2 max-w-full overflow-x-auto">
              <table className="min-w-full border-collapse text-left text-xs">{children}</table>
            </div>
          ),
          td: ({ children }) => <td className="border border-[var(--border)] px-2 py-1.5 align-top">{children}</td>,
          th: ({ children }) => <th className="border border-[var(--border)] bg-[var(--panel-muted)] px-2 py-1.5 font-semibold">{children}</th>,
          ul: ({ children }) => <ul className="my-2 list-disc space-y-0.5 pl-5">{children}</ul>,
        }}
      >
        {body}
      </Markdown>
    </div>
  );
}
