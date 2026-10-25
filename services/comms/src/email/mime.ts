import { randomBytes } from 'node:crypto';

export interface MimeAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface OutgoingEmail {
  from: string;
  to: string[];
  cc: string[];
  replyTo: string | null;
  subject: string;
  text: string;
  html: string | null;
  messageId: string;
  inReplyTo?: string | null;
  references?: string[];
  attachments: MimeAttachment[];
}

/** RFC 2047 encoded-word for non-ASCII header text. */
export const encodeHeader = (s: string) =>
  /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;

/** Encode the display-name part of `Name <addr>`; bare addresses pass through. */
export const encodeAddress = (a: string) => {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(a);
  if (!m) return a.trim();
  const name = m[1]!.trim();
  if (!name) return `<${m[2]}>`;
  const enc = /^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/(["\\])/g, '\\$1')}"` : encodeHeader(name);
  return `${enc} <${m[2]}>`;
};

const b64 = (buf: Buffer) => (buf.toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');
const boundary = (tag: string) => `----=_procure_${tag}_${randomBytes(9).toString('hex')}`;

/** Build an RFC 5322 message (multipart/mixed → multipart/alternative text+html → attachments). */
export function buildMime(e: OutgoingEmail): Buffer {
  const h: string[] = [
    `From: ${encodeAddress(e.from)}`,
    `To: ${e.to.map(encodeAddress).join(', ')}`,
    ...(e.cc.length ? [`Cc: ${e.cc.map(encodeAddress).join(', ')}`] : []),
    ...(e.replyTo ? [`Reply-To: ${encodeAddress(e.replyTo)}`] : []),
    `Subject: ${encodeHeader(e.subject)}`,
    `Message-ID: ${e.messageId}`,
    ...(e.inReplyTo ? [`In-Reply-To: ${e.inReplyTo}`] : []),
    ...(e.references?.length ? [`References: ${e.references.join(' ')}`] : []),
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
  ];
  const alt = boundary('alt');
  const altPart = [
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    '',
    `--${alt}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(Buffer.from(e.text, 'utf8')),
    ...(e.html
      ? [
          `--${alt}`,
          'Content-Type: text/html; charset=utf-8',
          'Content-Transfer-Encoding: base64',
          '',
          b64(Buffer.from(e.html, 'utf8')),
        ]
      : []),
    `--${alt}--`,
  ].join('\r\n');

  if (!e.attachments.length) return Buffer.from([...h, altPart, ''].join('\r\n'), 'utf8');

  const mixed = boundary('mix');
  const parts = [
    ...h,
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    '',
    `--${mixed}`,
    altPart,
    ...e.attachments.flatMap((a) => {
      const name = encodeHeader(a.filename.replace(/["\r\n]/g, '_'));
      return [
        `--${mixed}`,
        `Content-Type: ${a.contentType}; name="${name}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${name}"`,
        '',
        b64(a.content),
      ];
    }),
    `--${mixed}--`,
    '',
  ];
  return Buffer.from(parts.join('\r\n'), 'utf8');
}
