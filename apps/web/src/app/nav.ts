import {
  BadgeCheck,
  BookOpen,
  Boxes,
  ClipboardList,
  FileSpreadsheet,
  FolderKanban,
  Home,
  Inbox,
  Landmark,
  type LucideIcon,
  Package,
  PackageCheck,
  ReceiptText,
  Settings,
  ShieldAlert,
  Sparkles,
  Store,
  Tags,
  Truck,
  Warehouse,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  perm?: string;
  end?: boolean;
}
export interface NavGroup {
  label: string | null;
  items: NavItem[];
}

export const INTERNAL_NAV: NavGroup[] = [
  {
    label: null,
    items: [
      { to: '/app', label: 'Home', icon: Home, end: true },
      { to: '/app/tasks', label: 'My work', icon: ClipboardList },
      { to: '/app/inbox', label: 'Inbox', icon: Inbox, perm: 'inbox:triage' },
      { to: '/app/approvals', label: 'Approvals', icon: BadgeCheck },
    ],
  },
  {
    label: 'Projects',
    items: [
      { to: '/app/projects', label: 'Projects', icon: FolderKanban },
      { to: '/app/quotes', label: 'Quotes', icon: FileSpreadsheet },
      { to: '/app/specs', label: 'Spec library', icon: Tags },
      { to: '/app/cost-requests', label: 'Cost requests', icon: ReceiptText },
    ],
  },
  {
    label: 'Fulfillment',
    items: [
      { to: '/app/orders', label: 'Purchase orders', icon: Package },
      { to: '/app/shipments', label: 'Shipments', icon: Truck },
      { to: '/app/storage', label: 'Receiving & storage', icon: Warehouse },
      { to: '/app/claims', label: 'Claims', icon: ShieldAlert },
    ],
  },
  {
    label: 'Finance',
    items: [{ to: '/app/finance', label: 'Invoices & bills', icon: Landmark, perm: 'finance:read' }],
  },
  {
    label: 'Library',
    items: [
      { to: '/app/catalog/standards', label: 'Brand standards', icon: BookOpen },
      { to: '/app/catalog/vendors', label: 'Vendors', icon: Store },
      { to: '/app/catalog/products', label: 'Products', icon: Boxes },
    ],
  },
  {
    label: null,
    items: [
      { to: '/app/ai', label: 'AI assistant', icon: Sparkles, perm: 'ai:use' },
      { to: '/app/settings', label: 'Settings', icon: Settings },
    ],
  },
];

export const VENDOR_NAV: NavItem[] = [
  { to: '/vendor', label: 'Overview', icon: Home, end: true },
  { to: '/vendor/cost-requests', label: 'Pricing requests', icon: ReceiptText },
  { to: '/vendor/orders', label: 'Purchase orders', icon: PackageCheck },
  { to: '/vendor/claims', label: 'Claims', icon: ShieldAlert },
  { to: '/vendor/profile', label: 'Company profile', icon: Store },
];

export const CLIENT_NAV: NavItem[] = [
  { to: '/portal', label: 'Projects', icon: FolderKanban, end: true },
  { to: '/portal/approvals', label: 'Approvals', icon: BadgeCheck },
  { to: '/portal/claims', label: 'Claims', icon: ShieldAlert },
  { to: '/portal/invoices', label: 'Invoices', icon: Landmark },
];

/** Routes that aren't nav items but share a nav item's permission. */
const EXTRA_ROUTE_PERMS: [string, string][] = [['/app/invoices', 'finance:read']];

/** Permission needed to open an internal route (direct links included), or null. */
export function requiredPerm(pathname: string): string | null {
  const rules: [string, string][] = [
    ...INTERNAL_NAV.flatMap((g) =>
      g.items.filter((i) => i.perm && !i.end).map((i) => [i.to, i.perm!] as [string, string]),
    ),
    ...EXTRA_ROUTE_PERMS,
  ];
  const hit = rules
    .filter(([to]) => pathname === to || pathname.startsWith(`${to}/`))
    .sort((a, b) => b[0].length - a[0].length)[0];
  return hit?.[1] ?? null;
}
