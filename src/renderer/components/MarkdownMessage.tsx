import { Children, isValidElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "./ui/button";

interface MarkdownMessageProps {
  text: string;
  onOpenExternal(url: string): Promise<void> | void;
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function codeText(children: ReactNode): string {
  const child = Children.toArray(children)[0];
  if (!isValidElement<{ children?: ReactNode }>(child)) return "";
  return String(child.props.children ?? "").replace(/\n$/, "");
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const text = codeText(children);
  return (
    <div className="group/code relative my-3 overflow-hidden rounded-xl border bg-muted/50">
      <Button
        aria-label="Copy code"
        className="absolute top-2 right-2 z-10 opacity-0 transition-opacity group-hover/code:opacity-100 focus:opacity-100"
        onClick={async () => {
          await window.appBuilder.clipboard.copy(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1_500);
        }}
        size="icon-sm"
        title="Copy code"
        type="button"
        variant="outline"
      >
        {copied ? <Check /> : <Copy />}
      </Button>
      <pre className="overflow-x-auto p-4 pr-12 text-xs leading-relaxed">{children}</pre>
    </div>
  );
}

export function MarkdownMessage({ text, onOpenExternal }: MarkdownMessageProps) {
  return (
    <div className="markdown-body min-w-0 break-words">
      <ReactMarkdown
        components={{
          a: ({ href, children }) => {
            const url = safeUrl(href ?? "");
            return url ? (
              <a
                href={url}
                onClick={(event) => {
                  event.preventDefault();
                  void onOpenExternal(url);
                }}
                rel="noreferrer"
              >
                {children}
              </a>
            ) : <span>{children}</span>;
          },
          code: ({ className, children }) => <code className={className}>{children}</code>,
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        }}
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={safeUrl}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export { safeUrl };
