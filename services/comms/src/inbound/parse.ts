import { convert } from 'html-to-text';
import { type AddressObject, simpleParser } from 'mailparser';

export interface Address {
  address: string;
  name: string | null;
}

export interface ParsedAttachment {
  filename: string;
  contentType: string;
  size: number;
  content: Buffer;
  /** Inline images referenced from the HTML (cid:) — kept, but flagged. */
  inline: boolean;
}

export interface ParsedEmail {
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: Address;
  to: Address[];
  cc: Address[];
  /** Envelope / Delivered-To recipients not visible in To/Cc (e.g. a forwarded mailbox, BCC). */
  deliveredTo: string[];
  subject: string;
  text: string;
  html: string | null;
  date: string | null;
  attachments: ParsedAttachment[];
}

const lower = (s: string) => s.trim().toLowerCase();

/** Parse one address string: `Jane Doe <jane@x.com>`, `"Doe, Jane" <jane@x.com>`, `jane@x.com`. */
export function parseAddress(raw: string): Address | null {
  const s = raw.trim();
  if (!s) return null;
  const m = /^\s*(?:"?([^"<]*?)"?\s*)?<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/.exec(s);
  if (m) return { address: lower(m[2]!), name: m[1]?.trim() || null };
  const bare = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.exec(s);
  return bare ? { address: lower(s), name: null } : null;
}

/** Parse a comma-separated address list, respecting quoted display names containing commas. */
export function parseAddressList(raw: string | string[] | undefined | null): Address[] {
  if (!raw) return [];
  const items = Array.isArray(raw) ? raw : [raw];
  const out: Address[] = [];
  for (const item of items) {
    let buf = '';
    let quoted = false;
    let angle = false;
    for (const ch of `${item},`) {
      if (ch === '"') quoted = !quoted;
      else if (ch === '<') angle = true;
      else if (ch === '>') angle = false;
      if (ch === ',' && !quoted && !angle) {
        const a = parseAddress(buf);
        if (a) out.push(a);
        buf = '';
      } else buf += ch;
    }
  }
  return dedupe(out);
}

const dedupe = (list: Address[]) => {
  const seen = new Set<string>();
  return list.filter((a) => {
    if (seen.has(a.address)) return false;
    seen.add(a.address);
    return true;
  });
};

const fromAddressObject = (o: AddressObject | AddressObject[] | undefined): Address[] => {
  const list = Array.isArray(o) ? o : o ? [o] : [];
  const out: Address[] = [];
  type Entry = { address?: string; name?: string; group?: Entry[] };
  const walk = (vals: Entry[]) => {
    for (const v of vals) {
      if (v.group) walk(v.group);
      else if (v.address) out.push({ address: lower(v.address), name: v.name?.trim() || null });
    }
  };
  for (const obj of list) walk(obj.value);
  return dedupe(out);
};

const headerList = (v: unknown): string[] => {
  if (!v) return [];
  if (Array.isArray(v)) return v.flatMap(headerList);
  if (typeof v === 'string') return [v];
  if (typeof v === 'object' && v && 'text' in v) return [String((v as { text: string }).text)];
  return [];
};

/** Parse raw RFC 5322 bytes with mailparser into the shape the pipeline stores. */
export async function parseRawEmail(raw: Buffer): Promise<ParsedEmail> {
  const m = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
  const from = fromAddressObject(m.from)[0] ?? { address: 'unknown@invalid', name: null };
  const html = typeof m.html === 'string' && m.html.trim() ? m.html : null;
  const text = m.text?.trim() ? m.text : html ? convert(html, { wordwrap: false }) : '';
  const delivered = [
    ...headerList(m.headers.get('delivered-to')),
    ...headerList(m.headers.get('x-original-to')),
    ...headerList(m.headers.get('envelope-to')),
    ...headerList(m.headers.get('x-forwarded-to')),
  ].flatMap((s) => parseAddressList(s).map((a) => a.address));
  const refs = m.references ? (Array.isArray(m.references) ? m.references : m.references.split(/\s+/)) : [];
  return {
    messageId: m.messageId ?? null,
    inReplyTo: m.inReplyTo ?? null,
    references: refs.filter(Boolean),
    from,
    to: fromAddressObject(m.to),
    cc: fromAddressObject(m.cc),
    deliveredTo: [...new Set(delivered)],
    subject: m.subject ?? '',
    text,
    html,
    date: m.date ? m.date.toISOString() : null,
    attachments: m.attachments.map((a, i) => ({
      filename: a.filename || `attachment-${i + 1}${a.contentType === 'application/pdf' ? '.pdf' : ''}`,
      contentType: a.contentType || 'application/octet-stream',
      size: a.size ?? a.content.length,
      content: a.content,
      inline: a.contentDisposition === 'inline' && !!a.cid,
    })),
  };
}
