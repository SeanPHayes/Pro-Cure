import { convert } from 'html-to-text';

export interface TemplateInput {
  tenantName: string;
  /** Plain text body; blank lines separate paragraphs. Used when `html` is not given. */
  text: string;
  /** Pre-rendered inner HTML (trusted, produced by another service). Wrapped in the layout. */
  html?: string | null;
  heading?: string | null;
  cta?: { label: string; url: string } | null;
  /** Extra footer line, e.g. "Reply to this email to respond on the thread." */
  footerNote?: string | null;
}

export const escapeHtml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const linkify = (escaped: string) =>
  escaped.replace(
    /\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)]/g,
    (u) => `<a href="${u}" style="color:#1f4e79">${u}</a>`,
  );

/** Paragraphs from plain text: blank-line separated, single newlines become <br>. */
export const textToHtml = (text: string) =>
  text
    .trim()
    .split(/\n\s*\n/)
    .filter(Boolean)
    .map(
      (p) =>
        `<p style="margin:0 0 14px;line-height:1.55">${linkify(escapeHtml(p)).replace(/\n/g, '<br>')}</p>`,
    )
    .join('\n');

/** Detect a "call to action" URL in plain text we generate: a line "Open: <url>" or "<label>: <url>". */
export function extractCta(text: string): { text: string; cta: { label: string; url: string } | null } {
  const m =
    /^(Open|View|Respond|Review|Accept invitation|Open the request)[^:\n]*:\s*(https?:\/\/\S+)\s*$/im.exec(
      text,
    );
  if (!m) return { text, cta: null };
  return { text: text.replace(m[0], '').trim(), cta: { label: m[1]!, url: m[2]! } };
}

/**
 * Professional transactional layout: tenant name header, body, optional CTA button, footer
 * "Sent via Pro-Cure on behalf of <tenant>". Inline styles only (email clients ignore <style>).
 */
export function renderEmail(t: TemplateInput): { html: string; text: string } {
  const inner = t.html?.trim() ? t.html : textToHtml(t.text);
  const tenant = escapeHtml(t.tenantName);
  const heading = t.heading
    ? `<h1 style="margin:0 0 18px;font-size:20px;line-height:1.3;color:#111827">${escapeHtml(t.heading)}</h1>`
    : '';
  const cta = t.cta
    ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:22px 0 6px"><tr>
         <td style="border-radius:6px;background:#1f4e79">
           <a href="${escapeHtml(t.cta.url)}" style="display:inline-block;padding:12px 22px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px">${escapeHtml(t.cta.label)}</a>
         </td></tr></table>
       <p style="margin:8px 0 0;font-size:12px;color:#6b7280">Or paste this link into your browser: ${escapeHtml(t.cta.url)}</p>`
    : '';
  const note = t.footerNote ? `<p style="margin:0 0 6px">${escapeHtml(t.footerNote)}</p>` : '';
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${tenant}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1f2937;font-size:15px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f4f6;padding:24px 12px"><tr><td align="center">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px">
    <tr><td style="padding:18px 28px;border-bottom:3px solid #1f4e79;font-size:17px;font-weight:700;color:#1f4e79;letter-spacing:.2px">${tenant}</td></tr>
    <tr><td style="padding:26px 28px 22px">${heading}${inner}${cta}</td></tr>
    <tr><td style="padding:16px 28px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280">${note}<p style="margin:0">Sent via Pro-Cure on behalf of ${tenant}</p></td></tr>
  </table>
</td></tr></table>
</body></html>`;
  const text =
    convert(html, {
      wordwrap: 100,
      selectors: [
        { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
        { selector: 'h1', options: { uppercase: false } },
        { selector: 'table', format: 'block' },
        { selector: 'tr', format: 'block' },
        { selector: 'td', format: 'block' },
      ],
    }).trim() + '\n';
  return { html, text };
}
