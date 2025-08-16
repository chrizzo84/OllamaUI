'use client';
import React from 'react';
import Image from 'next/image';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function NewsViewer({ content }: { content: string }) {
  const [mode, setMode] = React.useState<'rendered' | 'raw'>('rendered');
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2 text-xs">
        <button
          type="button"
          onClick={() => setMode('rendered')}
          className={`px-3 py-1 rounded-md border transition ${
            mode === 'rendered'
              ? 'border-indigo-400/60 bg-indigo-500/20 text-indigo-200'
              : 'border-white/15 bg-white/5 text-white/50 hover:border-white/30 hover:text-white'
          }`}
          aria-pressed={mode === 'rendered'}
        >
          Rendered
        </button>
        <button
          type="button"
          onClick={() => setMode('raw')}
          className={`px-3 py-1 rounded-md border transition ${
            mode === 'raw'
              ? 'border-indigo-400/60 bg-indigo-500/20 text-indigo-200'
              : 'border-white/15 bg-white/5 text-white/50 hover:border-white/30 hover:text-white'
          }`}
          aria-pressed={mode === 'raw'}
        >
          Raw
        </button>
      </div>
      {mode === 'raw' ? (
        <pre className="rounded-lg border border-white/10 bg-black/40 p-4 text-xs leading-relaxed overflow-auto whitespace-pre-wrap font-mono">
          {content}
        </pre>
      ) : (
        <article className="prose prose-invert max-w-none prose-sm prose-headings:font-semibold prose-headings:tracking-tight prose-p:leading-relaxed prose-li:leading-relaxed">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              code({ className, children, ...props }) {
                const childArr = Array.isArray(children) ? children : [children];
                const isInline = !(childArr.length > 0 && String(childArr[0]).includes('\n'));
                const match = /language-(\w+)/.exec(className || '');
                if (isInline) {
                  return (
                    <code className="px-1 rounded bg-white/10 text-[90%]" {...props}>
                      {children}
                    </code>
                  );
                }
                return (
                  <pre className="rounded-md bg-black/50 p-3 overflow-auto text-xs">
                    <code className={className} data-lang={match ? match[1] : undefined} {...props}>
                      {children}
                    </code>
                  </pre>
                );
              },
              a({ children, href, ...props }) {
                return (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-indigo-300 hover:text-indigo-200 underline decoration-dotted"
                    {...props}
                  >
                    {children}
                  </a>
                );
              },
              table({ children }) {
                return (
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-xs">{children}</table>
                  </div>
                );
              },
              th({ children }) {
                return (
                  <th className="border border-white/15 bg-white/10 px-2 py-1 font-medium text-white/80 text-left">
                    {children}
                  </th>
                );
              },
              td({ children }) {
                return (
                  <td className="border border-white/10 px-2 py-1 text-white/70 align-top">
                    {children}
                  </td>
                );
              },
              img({ src, alt, width, height, ...props }) {
                let raw = typeof src === 'string' ? src : '';
                // Normalize relative path so markdown "image.png" looks in /public
                if (raw && !raw.startsWith('/') && !/^https?:\/\//.test(raw)) {
                  // Prefix with /news/ for assets colocated with News.md
                  raw = '/news/' + raw.replace(/^\.\//, '');
                }
                const isRemote = /^https?:\/\//.test(raw);
                const imgWidth = typeof width === 'string' ? parseInt(width, 10) : width;
                const imgHeight = typeof height === 'string' ? parseInt(height, 10) : height;
                return (
                  <span className="block my-4 max-w-full text-center">
                    {isRemote ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={raw}
                        alt={alt || ''}
                        className="mx-auto rounded-lg border border-white/10 shadow-md max-w-full h-auto"
                        loading="lazy"
                        {...props}
                      />
                    ) : (
                      <Image
                        src={raw || ''}
                        alt={alt || ''}
                        width={imgWidth || 1200}
                        height={imgHeight || 800}
                        className="mx-auto rounded-lg border border-white/10 shadow-md h-auto w-auto max-w-full"
                        {...props}
                      />
                    )}
                    {alt && (
                      <span className="mt-1 block text-center text-[11px] text-white/40">
                        {alt}
                      </span>
                    )}
                  </span>
                );
              },
            }}
          >
            {content}
          </ReactMarkdown>
        </article>
      )}
    </div>
  );
}
