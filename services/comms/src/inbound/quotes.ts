/**
 * Strip quoted history and signatures-separators from a plain-text email reply so the thread shows
 * only what the sender wrote. The full HTML (with history) is kept on the message for reference.
 *
 * Handles the common client patterns:
 *   - "On Mon, Oct 5, 2026 at 9:14 AM Jane <jane@x.com> wrote:" (Gmail/Apple; may wrap onto 2 lines)
 *   - "-----Original Message-----" (Outlook), "________________________________" + "From:" header block
 *   - "From: … Sent: … To: … Subject:" header block without a separator (Outlook mobile)
 *   - "Le … a écrit :", "Am … schrieb …:", "El … escribió:" (common non-English clients)
 *   - lines starting with ">"
 *   - "Sent from my iPhone" / "Get Outlook for iOS" trailers
 */
const CUT_PATTERNS: RegExp[] = [
  /^-{2,}\s*Original Message\s*-{2,}\s*$/i,
  /^-{2,}\s*Forwarded message\s*-{2,}\s*$/i,
  /^_{10,}\s*$/,
  /^On\s.+\bwrote:\s*$/i,
  /^Le\s.+\ba écrit\s*:\s*$/i,
  /^Am\s.+\bschrieb\b.*:\s*$/i,
  /^El\s.+\bescribió\s*:\s*$/i,
  /^Begin forwarded message:\s*$/i,
];
const TRAILERS = [
  /^Sent from my (iPhone|iPad|Android|mobile device|Samsung).*$/i,
  /^Get Outlook for (iOS|Android).*$/i,
];

const isHeaderBlockStart = (lines: string[], i: number) => {
  // "From: x" followed within 4 lines by "Sent:"/"Date:" and "Subject:"/"To:"
  if (!/^\*?From:\*?\s.+/i.test(lines[i] ?? '')) return false;
  const next = lines.slice(i + 1, i + 6).join('\n');
  return /^\*?(Sent|Date):\*?\s/im.test(next) && /^\*?(To|Subject):\*?\s/im.test(next);
};

export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    // "On … wrote:" wrapped across two lines.
    const joined = `${line} ${(lines[i + 1] ?? '').trim()}`;
    if (
      CUT_PATTERNS.some((re) => re.test(line)) ||
      (/^On\s/i.test(line) && /\bwrote:\s*$/i.test(joined) && !/\bwrote:/i.test(line)) ||
      isHeaderBlockStart(
        lines.map((l) => l.trim()),
        i,
      )
    ) {
      cut = i;
      break;
    }
    // A run of quoted lines that continues to the end (or only blank/quoted lines follow).
    if (line.startsWith('>')) {
      const rest = lines.slice(i);
      if (rest.every((l) => l.trim() === '' || l.trim().startsWith('>'))) {
        cut = i;
        break;
      }
    }
  }
  const kept = lines
    .slice(0, cut)
    .filter((l) => !l.trim().startsWith('>')) // interleaved quotes
    .filter((l) => !TRAILERS.some((re) => re.test(l.trim())));
  const out = kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // If the whole message was quoted (e.g. a bare forward), keep the original rather than nothing.
  return out || text.trim();
}
