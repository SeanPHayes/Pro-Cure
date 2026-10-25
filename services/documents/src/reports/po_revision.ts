import type { z } from '@procure/platform';
import type { PoRevisionData } from './data.js';
import { purchaseOrderDoc } from './purchase_order.js';

/**
 * A revised PO: the full purchase order with every changed header field and line highlighted in
 * amber, a "Changed" column showing from → to per line, a revision summary table, and removed lines.
 */
export const poRevisionDoc = (d: z.infer<typeof PoRevisionData>, generatedAt = new Date()) =>
  purchaseOrderDoc(d, { revision: true }, generatedAt);
