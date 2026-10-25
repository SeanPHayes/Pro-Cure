import type { ReactNode } from 'react';
import { cx } from '@/components/ui';

// ------------------------------------------------------------------ identity shapes
export interface Member {
  membershipId: string;
  userId: string;
  email: string;
  name: string;
  title: string | null;
  phone: string | null;
  orgId: string;
  orgName: string;
  orgType: string;
  roles: string[];
  status: string;
  lastLoginAt: string | null;
}
export interface Org {
  id: string;
  type: 'procurement_firm' | 'vendor' | 'client' | 'platform';
  name: string;
  legalName: string | null;
  slug: string;
  website: string | null;
  phone: string | null;
  email: string | null;
  address: Record<string, unknown>;
  status: string;
  relationship?: string | null;
  memberCount?: number;
  createdAt: string;
}
export interface InviteResult {
  userId: string;
  membershipId: string;
  inviteUrl: string;
}

export const settingsKeys = {
  users: (orgId: string) => ['settings', 'users', orgId] as const,
  orgs: (type: string) => ['settings', 'orgs', type] as const,
  policies: ['settings', 'approval-policies'] as const,
  templates: ['settings', 'task-templates'] as const,
  template: (id: string) => ['settings', 'task-template', id] as const,
  mailboxes: ['settings', 'mailboxes'] as const,
  emails: (q: object) => ['settings', 'emails', q] as const,
  email: (id: string) => ['settings', 'email', id] as const,
  prefs: ['settings', 'notification-preferences'] as const,
  me: ['settings', 'me'] as const,
};

// ------------------------------------------------------------------ roles
export interface RoleInfo {
  value: string;
  label: string;
  can: string;
}

/** Internal roles with what each can do (mirrors ROLE_PERMISSIONS in packages/domain/src/auth.ts). */
export const INTERNAL_ROLES: RoleInfo[] = [
  { value: 'admin', label: 'Administrator', can: 'Everything, including people, settings and integrations.' },
  {
    value: 'executive',
    label: 'Operations executive',
    can: 'Sees costs and finance, approves quotes held by approval policies, edits approval policies.',
  },
  {
    value: 'project_manager',
    label: 'Project manager',
    can: 'Runs projects and schedules, edits task templates, sends quotes to owners, handles claims.',
  },
  { value: 'designer', label: 'Designer', can: 'Builds specs and quotes; works project tasks.' },
  {
    value: 'procurement',
    label: 'Procurement',
    can: 'Prices quotes, requests vendor costs, creates and issues POs, triages the inbox.',
  },
  {
    value: 'order_manager',
    label: 'Order manager',
    can: 'Issues and tracks POs, shipments and claims; triages the inbox.',
  },
  {
    value: 'logistics',
    label: 'Logistics',
    can: 'Shipments, tracking, receiving and claims; triages the inbox.',
  },
  {
    value: 'accounting',
    label: 'Accounting',
    can: 'Invoices, vendor bills, payments and the QuickBooks connection.',
  },
  { value: 'sales', label: 'Sales', can: 'Creates projects and sends quotes to owners.' },
  { value: 'viewer', label: 'Viewer', can: 'Read-only access to projects, quotes and orders (no costs).' },
];
export const VENDOR_ROLES: RoleInfo[] = [
  {
    value: 'vendor_admin',
    label: 'Vendor administrator',
    can: 'Responds to pricing requests and POs, and invites their own colleagues.',
  },
  {
    value: 'vendor_user',
    label: 'Vendor user',
    can: 'Responds to pricing requests and POs, and sends messages.',
  },
];
export const CLIENT_ROLES: RoleInfo[] = [
  {
    value: 'client_admin',
    label: 'Owner administrator',
    can: 'Sees projects, approves quotes, reports claims, manages storage and their own users.',
  },
  { value: 'client_approver', label: 'Approver', can: 'Sees projects, approves quotes and reports claims.' },
  {
    value: 'client_viewer',
    label: 'Viewer',
    can: 'Sees project progress and documents shared with the owner.',
  },
  {
    value: 'site_manager',
    label: 'Site manager',
    can: 'Reports claims and manages on-site storage and deliveries.',
  },
];
const ALL_ROLES = [...INTERNAL_ROLES, ...VENDOR_ROLES, ...CLIENT_ROLES];
export const roleLabel = (r: string) => ALL_ROLES.find((x) => x.value === r)?.label ?? r.replace(/_/g, ' ');
export const rolesFor = (orgType: string) =>
  orgType === 'vendor' ? VENDOR_ROLES : orgType === 'client' ? CLIENT_ROLES : INTERNAL_ROLES;

/** Checkbox list of roles with their plain-language descriptions. */
export function RolePicker({
  roles,
  value,
  onChange,
  disabled,
}: {
  roles: RoleInfo[];
  value: string[];
  onChange: (v: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <ul className="divide-y divide-line-2 rounded-sm border border-line">
      {roles.map((r) => {
        const on = value.includes(r.value);
        return (
          <li key={r.value}>
            <label
              className={cx(
                'flex cursor-pointer items-start gap-2.5 px-3 py-2',
                on ? 'bg-lacquer-50' : 'hover:bg-stone',
                disabled && 'cursor-not-allowed opacity-60',
              )}
            >
              <input
                type="checkbox"
                className="mt-1 size-4 accent-lacquer"
                checked={on}
                disabled={disabled}
                onChange={(e) =>
                  onChange(e.target.checked ? [...value, r.value] : value.filter((x) => x !== r.value))
                }
              />
              <span className="min-w-0">
                <span className="block font-[560]">{r.label}</span>
                <span className="block text-[12.5px] text-ink-3">{r.can}</span>
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

/** Title + description block that opens each settings tab. */
export function TabIntro({
  title,
  children,
  actions,
}: {
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-[17px] font-[640]">{title}</h2>
        {children && <p className="mt-1 max-w-[68ch] text-ink-2">{children}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
