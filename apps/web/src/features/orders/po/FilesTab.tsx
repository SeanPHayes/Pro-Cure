import { useState } from 'react';
import { DocumentsPanel } from '@/components/shared/DocumentsPanel';
import { Section } from '@/components/ui';
import { Switch } from '@/components/ui/Switch';
import type { PoDetail } from '../types';

/** PO files. Files tagged "Shared with vendor" appear in the vendor's portal. */
export function FilesTab({ po }: { po: PoDetail }) {
  const [share, setShare] = useState(!!po.vendorOrgId);
  return (
    <Section
      title="Files"
      actions={
        po.vendorOrgId && (
          <span className="flex items-center gap-2 text-[13px] text-ink-2">
            <Switch checked={share} onChange={setShare} label="Share new uploads with the vendor" />
            Share new uploads with {po.vendorName}
          </span>
        )
      }
    >
      <p className="mb-3 text-[13px] text-ink-3">
        PO and revision PDFs, shop drawings, finish samples and delivery photos.{' '}
        {po.vendorOrgId
          ? 'Files marked “Shared with vendor” are visible in their portal; the rest stay with your team.'
          : `${po.vendorName} isn’t on the vendor portal, so files stay with your team.`}
      </p>
      <DocumentsPanel
        entityType="purchase_order"
        entityId={po.id}
        visibility={share && po.vendorOrgId ? 'vendor' : 'internal'}
        vendorOrgId={share ? po.vendorOrgId : null}
        defaultKind="shop_drawing"
      />
    </Section>
  );
}
