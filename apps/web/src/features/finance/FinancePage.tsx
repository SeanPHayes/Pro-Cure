import { Download, Plus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { Button, Menu, PageHeader, Tabs } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { BillsTab } from './BillsTab';
import { InvoicesTab } from './InvoicesTab';
import { OverviewTab } from './OverviewTab';
import { QuickBooksTab } from './QuickBooksTab';
import { BillSheet, downloadAuthed, InvoiceSheet } from './shared';

const TABS = ['overview', 'invoices', 'bills', 'quickbooks'] as const;
type Tab = (typeof TABS)[number];

export function Component() {
  const s = useSession();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab') as Tab | null;
  const tab: Tab = raw && TABS.includes(raw) ? raw : 'overview';
  const canWrite = hasPerm(s, 'finance:write');
  const [newInvoice, setNewInvoice] = useState(false);
  const [newBill, setNewBill] = useState(false);
  const projectId = params.get('projectId') ?? undefined;

  /** Switching tabs drops the previous tab's filters; `extra` lets the overview deep-link a filter. */
  const go = (t: string, extra?: Record<string, string>) =>
    setParams(new URLSearchParams({ ...(t === 'overview' ? {} : { tab: t }), ...extra }), { replace: false });

  const exportFile = (path: string, name: string) =>
    downloadAuthed(path, name, { projectId }).catch((e) => toast.error(`Export failed: ${errorMessage(e)}`));

  return (
    <>
      <PageHeader
        title="Invoices & bills"
        description="Owner billing, vendor payables and project cash, kept in step with QuickBooks."
        actions={
          <>
            <Menu
              trigger={(toggle) => (
                <Button icon={<Download className="size-4" />} onClick={toggle}>
                  Export
                </Button>
              )}
              items={[
                {
                  label: 'Invoices (CSV)',
                  onSelect: () => exportFile('/exports/invoices.csv', 'invoices.csv'),
                },
                {
                  label: 'Vendor bills (CSV)',
                  onSelect: () => exportFile('/exports/bills.csv', 'bills.csv'),
                },
                'divider',
                {
                  label: 'QuickBooks Desktop (IIF)',
                  onSelect: () => exportFile('/exports/qbo.iif', 'quickbooks.iif'),
                },
              ]}
            />
            {canWrite && tab === 'bills' ? (
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setNewBill(true)}>
                Enter bill
              </Button>
            ) : canWrite ? (
              <Button
                variant="primary"
                icon={<Plus className="size-4" />}
                onClick={() => setNewInvoice(true)}
              >
                New invoice
              </Button>
            ) : null}
          </>
        }
      >
        <Tabs
          className="mt-4 -mb-4"
          value={tab}
          onChange={(t) => go(t)}
          items={[
            { value: 'overview', label: 'Overview' },
            { value: 'invoices', label: 'Invoices' },
            { value: 'bills', label: 'Vendor bills' },
            { value: 'quickbooks', label: 'QuickBooks' },
          ]}
        />
      </PageHeader>

      {tab === 'overview' && <OverviewTab go={go} />}
      {tab === 'invoices' && <InvoicesTab onNew={canWrite ? () => setNewInvoice(true) : undefined} />}
      {tab === 'bills' && <BillsTab onNew={canWrite ? () => setNewBill(true) : undefined} />}
      {tab === 'quickbooks' && <QuickBooksTab />}

      <InvoiceSheet
        open={newInvoice}
        onClose={() => setNewInvoice(false)}
        defaultProjectId={projectId}
        onSaved={(inv) => nav(`/app/invoices/${inv.id}`)}
      />
      <BillSheet open={newBill} onClose={() => setNewBill(false)} defaultProjectId={projectId} />
    </>
  );
}
