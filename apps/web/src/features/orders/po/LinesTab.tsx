import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { cx, Section } from '@/components/ui';
import { api } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { count, money } from '@/lib/format';
import { useInvalidateOrders } from '../shared';
import type { PoDetail, PoLine } from '../types';

/** PO lines. Internal users edit quantity and unit cost inline; on an issued PO that marks unissued changes. */
export function LinesTab({ po }: { po: PoDetail }) {
  const s = useSession();
  const editable = hasPerm(s, 'orders:write') && !['cancelled', 'closed', 'delivered'].includes(po.status);
  const received = po.lines.reduce((a, l) => a + l.receivedQty, 0);
  const ordered = po.lines.reduce((a, l) => a + l.quantity, 0);
  return (
    <Section
      title={
        <span>
          Lines{' '}
          <span className="num ml-1 font-[520] text-ink-3">
            {po.lines.length} · {count(ordered)} units · {count(received)} received
          </span>
        </span>
      }
      bodyClassName=""
    >
      {editable && po.status !== 'draft' && (
        <p className="border-b border-line-2 bg-brass-50/60 px-4 py-2 text-[13px] text-ink-2">
          Edits here are held as unissued changes. Issue a revision to send the vendor a PDF with the changes
          highlighted.
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="grid-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Item</th>
              <th>Location</th>
              <th className="right">Qty</th>
              <th className="right">Received</th>
              <th className="right">Unit cost</th>
              <th className="right">Extended</th>
            </tr>
          </thead>
          <tbody>
            {po.lines.map((l) => (
              <LineRow key={l.id} po={po} line={l} editable={editable} />
            ))}
          </tbody>
          <tfoot>
            <TotalRow label="Subtotal" value={po.subtotal} />
            {po.freight > 0 && <TotalRow label="Freight" value={po.freight} />}
            {po.tax > 0 && <TotalRow label="Tax" value={po.tax} />}
            <TotalRow label="Total" value={po.total} strong />
          </tfoot>
        </table>
      </div>
    </Section>
  );
}

const TotalRow = ({ label, value, strong }: { label: string; value: number; strong?: boolean }) => (
  <tr>
    <td colSpan={6} className={cx('right !border-b-0 py-1.5 text-ink-2', strong && 'font-[620] text-ink')}>
      {label}
    </td>
    <td className={cx('right num !border-b-0 py-1.5', strong && 'text-[15px] font-[640]')}>{money(value)}</td>
  </tr>
);

function LineRow({ po, line, editable }: { po: PoDetail; line: PoLine; editable: boolean }) {
  const invalidate = useInvalidateOrders();
  const m = useMutation({
    mutationFn: (body: { quantity?: number; unitCost?: number }) =>
      api.patch('orders', `/purchase-orders/${po.id}/lines/${line.id}`, body),
    onSuccess: () => {
      toast.success(`${line.code} updated`);
      invalidate();
    },
  });
  return (
    <tr>
      <td className="num whitespace-nowrap text-ink-2">{line.code}</td>
      <td>
        <div className="min-w-[220px] font-[560]">{line.name}</div>
        <div className="text-[12px] text-ink-3">
          {[line.vendorSku && `SKU ${line.vendorSku}`, line.finish, line.dimensions]
            .filter(Boolean)
            .join(' · ')}
        </div>
      </td>
      <td className="text-[13px] text-ink-2">
        <div className="max-w-[180px] truncate">{line.locationName ?? '—'}</div>
      </td>
      <td className="right num">
        {editable ? (
          <NumCell
            value={line.quantity}
            label={`Quantity for ${line.code}`}
            min={line.receivedQty}
            onSave={(quantity) => m.mutate({ quantity })}
          />
        ) : (
          count(line.quantity)
        )}
      </td>
      <td className={cx('right num', line.receivedQty >= line.quantity ? 'text-ok' : 'text-ink-2')}>
        {count(line.receivedQty)}
      </td>
      <td className="right num">
        {editable ? (
          <NumCell
            value={line.unitCost}
            label={`Unit cost for ${line.code}`}
            money
            onSave={(unitCost) => m.mutate({ unitCost })}
          />
        ) : (
          money(line.unitCost)
        )}
      </td>
      <td className="right num font-[560]">{money(line.extended)}</td>
    </tr>
  );
}

/** Inline numeric editor: commits on blur or Enter, Escape reverts. */
function NumCell({
  value,
  onSave,
  label,
  money: isMoney,
  min = 0,
}: {
  value: number;
  onSave: (v: number) => void;
  label: string;
  money?: boolean;
  min?: number;
}) {
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? (isMoney ? value.toFixed(2) : String(value));
  const commit = () => {
    if (text === null) return;
    const n = Number(text);
    setText(null);
    if (!Number.isFinite(n) || n < min) {
      toast.error(min > 0 ? `Must be at least ${min} (already received)` : 'Enter a valid number');
      return;
    }
    if (n !== value) onSave(n);
  };
  return (
    <input
      aria-label={label}
      inputMode="decimal"
      value={shown}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setText(null);
      }}
      className="num h-7 w-24 rounded-xs border border-transparent bg-transparent px-1.5 text-right hover:border-line hover:bg-paper focus:border-lacquer focus:bg-paper focus:outline-none"
    />
  );
}
