import { on } from '@procure/platform';

/**
 * orders.po.created → stamp po_id/po_number on the quote lines that went onto the PO; when every
 * ready-to-order line of the quote is ordered, the quote becomes 'ordered'. Idempotent: the platform
 * inbox dedupes event ids, and re-applying the same PO is a no-op.
 */
export const subscriptions = [
  on('orders.po.created', async (event, { tx, log }) => {
    const d = event.data;
    if (!d.quoteLineIds?.length) return;
    const updated = await tx<{ quoteId: string }[]>`
      update quoting.quote_lines set po_id = ${d.poId}, po_number = ${d.number}, ready_to_order = true
      where id in ${tx(d.quoteLineIds)} and (po_id is null or po_id = ${d.poId})
        and tenant_id = ${event.tenantId}
      returning quote_id`;
    if (updated.length !== d.quoteLineIds.length)
      log.warn(
        { poId: d.poId, expected: d.quoteLineIds.length, updated: updated.length },
        'some quote lines were not linked to the PO',
      );
    const quoteIds = [...new Set([...(d.quoteId ? [d.quoteId] : []), ...updated.map((u) => u.quoteId)])];
    for (const qid of quoteIds) {
      await tx`
        update quoting.quotes q set status = 'ordered'
        where q.id = ${qid} and q.status = 'client_approved'
          and exists (select 1 from quoting.quote_lines l where l.quote_id = q.id and l.po_id is not null)
          and not exists (select 1 from quoting.quote_lines l where l.quote_id = q.id and l.ready_to_order and l.is_selected and l.po_id is null)`;
    }
  }),
];
