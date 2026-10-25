import { describe, expect, it } from 'vitest';
import { parseAddress, parseAddressList } from '../src/inbound/parse.js';
import { stripQuotedReply } from '../src/inbound/quotes.js';

describe('stripQuotedReply', () => {
  it('cuts Gmail/Apple "On … wrote:" history', () => {
    expect(
      stripQuotedReply(
        'Confirmed for 11/14.\n\nOn Mon, Oct 20, 2026 at 9:14 AM Jane Doe <jane@x.com> wrote:\n> Can you confirm?\n> Thanks',
      ),
    ).toBe('Confirmed for 11/14.');
  });

  it('handles "On … wrote:" wrapped across two lines', () => {
    expect(
      stripQuotedReply('Yes.\n\nOn Mon, Oct 20, 2026 at 9:14 AM Jane Doe\n<jane@x.com> wrote:\n> Q?'),
    ).toBe('Yes.');
  });

  it('cuts Outlook "-----Original Message-----" and From/Sent header blocks', () => {
    expect(
      stripQuotedReply(
        'Attached.\n\n-----Original Message-----\nFrom: A\nSent: Monday\nTo: B\nSubject: X\n\nold',
      ),
    ).toBe('Attached.');
    expect(
      stripQuotedReply(
        'See OA.\n\n________________________________\nFrom: Purchasing <p@jmhs.example>\nSent: Monday, October 20, 2026 9:00 AM\nTo: Vince\nSubject: PO-26-0042',
      ),
    ).toBe('See OA.');
    expect(
      stripQuotedReply(
        'Done\n\nFrom: Purchasing <p@x.com>\nSent: Monday\nTo: Vince\nSubject: PO\n\nold body',
      ),
    ).toBe('Done');
  });

  it('removes trailing > blocks and mobile trailers but keeps the body', () => {
    expect(stripQuotedReply('Line one\nLine two\n\nSent from my iPhone\n\n> quoted\n>> deeper')).toBe(
      'Line one\nLine two',
    );
  });

  it('drops interleaved quoted lines', () => {
    expect(
      stripQuotedReply('> Can you ship Friday?\nYes, Friday works.\n> And the lamps?\nLamps next week.'),
    ).toBe('Yes, Friday works.\nLamps next week.');
  });

  it('handles common non-English clients', () => {
    expect(stripQuotedReply('Oui.\n\nLe lun. 20 oct. 2026 à 09:14, Jean <j@x.fr> a écrit :\n> ?')).toBe(
      'Oui.',
    );
    expect(stripQuotedReply('Ja.\n\nAm 20.10.2026 um 09:14 schrieb Hans <h@x.de>:\n> ?')).toBe('Ja.');
  });

  it('keeps text that has no quotes, and falls back to the original when everything is quoted', () => {
    expect(stripQuotedReply('Just a note.\r\nSecond line.')).toBe('Just a note.\nSecond line.');
    expect(stripQuotedReply('> all quoted\n> here')).toBe('> all quoted\n> here');
    expect(stripQuotedReply('We wrote: the price is firm.')).toBe('We wrote: the price is firm.');
  });
});

describe('address parsing', () => {
  it('parses display names, quotes and bare addresses', () => {
    expect(parseAddress('Jane Doe <Jane@X.com>')).toEqual({ address: 'jane@x.com', name: 'Jane Doe' });
    expect(parseAddress('jane@x.com')).toEqual({ address: 'jane@x.com', name: null });
    expect(parseAddress('not an address')).toBeNull();
    expect(parseAddressList('"Doe, Jane" <jane@x.com>, bob@y.com, jane@x.com')).toEqual([
      { address: 'jane@x.com', name: 'Doe, Jane' },
      { address: 'bob@y.com', name: null },
    ]);
  });
});
