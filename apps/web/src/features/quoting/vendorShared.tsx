import { useQuery } from '@tanstack/react-query';
import { api, type Page } from '@/lib/api';
import { date, daysFromToday, relativeDue } from '@/lib/format';
import type { VendorCostRequest } from './types';

/** Helpers shared by the vendor portal pricing pages. */
export const VENDOR_STATUS: Record<string, string> = {
  sent: 'New',
  viewed: 'In progress',
  responded: 'Submitted',
  partially_applied: 'Submitted',
  applied: 'Accepted',
  closed: 'Closed',
};
export const needsResponse = (r: VendorCostRequest) => r.status === 'sent' || r.status === 'viewed';

export const useVendorRequests = () =>
  useQuery({
    queryKey: ['vendor', 'cost-requests'],
    queryFn: () => api.get<Page<VendorCostRequest>>('quoting', '/vendor/cost-requests', { limit: 200 }),
  });

export function DueLabel({ r }: { r: VendorCostRequest }) {
  const d = daysFromToday(r.dueDate);
  if (!r.dueDate) return <span className="text-ink-4">No due date</span>;
  return (
    <span className="whitespace-nowrap">
      <span className="num">{date(r.dueDate)}</span>
      {needsResponse(r) && (
        <span
          className={`ml-1.5 text-[12px] ${d !== null && d < 0 ? 'font-[560] text-crit' : d !== null && d <= 2 ? 'text-warn' : 'text-ink-3'}`}
        >
          {relativeDue(r.dueDate)}
        </span>
      )}
    </span>
  );
}
