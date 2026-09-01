import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MessageMarkdown({ body }: { body: string }) {
  return (
    <div className="message-markdown break-words text-sm leading-6">
      <Markdown
        remarkPlugins={[remarkGfm]}
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
          pre: ({ children }) => (
            <pre className="my-2 max-w-full overflow-x-auto rounded-md border border-[var(--border)] bg-[var(--panel-muted)] p-3 font-mono text-xs leading-5 [&>code]:bg-transparent [&>code]:p-0">
              {children}
            </pre>
          ),
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
