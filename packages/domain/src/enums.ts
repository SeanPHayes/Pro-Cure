import { z } from 'zod';

// ---------- Organizations ----------
export const OrgType = z.enum(['procurement_firm', 'vendor', 'client', 'platform']);
export type OrgType = z.infer<typeof OrgType>;

// ---------- Projects ----------
export const ProjectType = z.enum(['renovation', 'new_construction', 'conversion', 'refresh', 'opening']);
export const ProjectStage = z.enum([
  'lead',
  'proposal',
  'design',
  'quoting',
  'client_approval',
  'procurement',
  'production',
  'logistics',
  'installation',
  'closeout',
  'complete',
]);
export type ProjectStage = z.infer<typeof ProjectStage>;
export const ProjectStatus = z.enum(['active', 'on_hold', 'won', 'lost', 'closed', 'cancelled']);
export const ProjectRole = z.enum([
  'project_manager',
  'designer',
  'procurement',
  'order_manager',
  'logistics',
  'sales',
  'accounting',
]);
export type ProjectRole = z.infer<typeof ProjectRole>;
export const TaskStatus = z.enum(['todo', 'in_progress', 'blocked', 'done', 'skipped']);
export const TaskParty = z.enum(['internal', 'client', 'vendor']);
export const TaskKind = z.enum(['task', 'approval', 'payment', 'milestone', 'document']);

// ---------- Specs & quotes ----------
export const SpecCategory = z.enum([
  'casegoods',
  'seating',
  'soft_seating',
  'tables',
  'bedding',
  'lighting',
  'mirrors',
  'artwork',
  'window_treatments',
  'carpet',
  'flooring',
  'wallcovering',
  'millwork',
  'plumbing',
  'electronics',
  'signage',
  'outdoor',
  'ose',
  'other',
]);
export type SpecCategory = z.infer<typeof SpecCategory>;
export const SpecDocumentKind = z.enum([
  'spec_sheet',
  'line_drawing',
  'shop_drawing',
  'finish_sample',
  'cfa',
  'approval_form',
  'image',
  'other',
]);
export const QuoteStatus = z.enum([
  'draft',
  'costing',
  'merchandising',
  'pending_internal_approval',
  'sent',
  'client_approved',
  'client_rejected',
  'ordered',
  'archived',
]);
export type QuoteStatus = z.infer<typeof QuoteStatus>;
export const QuantityMode = z.enum(['fixed', 'per_room']);
export const LineFlag = z.enum([
  'missing_cost',
  'missing_price',
  'below_cost',
  'cost_expired',
  'cost_expiring',
  'below_min_margin',
]);
export type LineFlag = z.infer<typeof LineFlag>;
export const CostRequestStatus = z.enum([
  'draft',
  'sent',
  'viewed',
  'responded',
  'partially_applied',
  'applied',
  'closed',
]);
export const CostResponseSource = z.enum(['portal', 'ai_pdf', 'manual']);
export const ApprovalStatus = z.enum(['pending', 'approved', 'rejected', 'cancelled']);

// ---------- Orders & logistics ----------
export const PoStatus = z.enum([
  'draft',
  'issued',
  'acknowledged',
  'in_production',
  'partially_shipped',
  'shipped',
  'partially_delivered',
  'delivered',
  'closed',
  'cancelled',
]);
export type PoStatus = z.infer<typeof PoStatus>;
export const PreOrderKind = z.enum([
  'order_acknowledgement',
  'deposit',
  'shop_drawing_approval',
  'finish_sample_approval',
  'cfa',
  'credit_approval',
  'other',
]);
export const RequirementStatus = z.enum(['pending', 'submitted', 'approved', 'rejected', 'waived']);
export const ShipmentStatus = z.enum([
  'planned',
  'confirmed',
  'in_production',
  'ready',
  'shipped',
  'in_transit',
  'delivered',
  'exception',
]);
export const Escalation = z.enum(['none', 'watch', 'at_risk', 'critical']);
export type Escalation = z.infer<typeof Escalation>;
export const Origin = z.enum(['domestic', 'international']);
export const ClaimType = z.enum(['damage', 'shortage', 'wrong_item', 'defect', 'concealed_damage', 'other']);
export const ClaimStatus = z.enum([
  'open',
  'submitted_to_vendor',
  'vendor_acknowledged',
  'replacement_ordered',
  'credited',
  'resolved',
  'rejected',
]);
export const StorageLocationKind = z.enum(['warehouse', 'on_site', 'staging']);
export const StorageItemStatus = z.enum(['in_transit', 'stored', 'staged', 'installed', 'damaged']);

// ---------- Finance ----------
export const InvoiceKind = z.enum(['deposit', 'progress', 'final', 'credit_memo']);
export const InvoiceStatus = z.enum(['draft', 'sent', 'partially_paid', 'paid', 'overdue', 'void']);
export const BillKind = z.enum(['deposit', 'balance', 'freight', 'other']);
export const BillStatus = z.enum(['open', 'scheduled', 'partially_paid', 'paid', 'void']);
export const SyncStatus = z.enum(['not_synced', 'pending', 'synced', 'error']);

// ---------- Comms ----------
export const ThreadVisibility = z.enum(['internal', 'vendor', 'client']);
export const MessageDirection = z.enum(['internal', 'outbound', 'inbound']);
export const InboundEmailStatus = z.enum(['pending', 'routed', 'needs_review', 'ignored']);

// ---------- AI ----------
export const AiJobKind = z.enum([
  'brand_spec_extract',
  'vendor_quote_extract',
  'drawing_split',
  'inbox_route',
  'risk_score',
]);
export type AiJobKind = z.infer<typeof AiJobKind>;
export const AiJobStatus = z.enum(['queued', 'running', 'needs_review', 'completed', 'failed', 'applied']);
