import { useMemo } from 'react';
import { cx } from '@/components/ui';

/**
 * Renders untrusted HTML (inbound and outbound email bodies) in a fully sandboxed iframe: no scripts,
 * no forms, no same-origin access, no top navigation, and a CSP that blocks every network fetch
 * (remote images, tracking pixels, fonts, styles). Only inline styles and data: images render.
 */
export function SandboxedHtml({
  html,
  title,
  className,
  height = 420,
}: {
  html: string;
  title: string;
  className?: string;
  height?: number;
}) {
  const doc = useMemo(
    () =>
      `<!doctype html><html><head><meta charset="utf-8">` +
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">` +
      `<base target="_blank">` +
      `<style>body{margin:0;padding:16px;font:14px/1.5 system-ui,sans-serif;color:#1a2230;word-wrap:break-word}img{max-width:100%;height:auto}</style>` +
      `</head><body>${html}</body></html>`,
    [html],
  );
  return (
    <iframe
      title={title}
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={doc}
      className={cx('w-full rounded-sm border border-line bg-white', className)}
      style={{ height }}
    />
  );
}
