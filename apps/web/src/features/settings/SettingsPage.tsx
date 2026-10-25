import {
  BadgeCheck,
  Bell,
  Building2,
  ListChecks,
  type LucideIcon,
  Mail,
  PlugZap,
  UserRound,
  Users,
} from 'lucide-react';
import { Navigate, NavLink, useParams } from 'react-router';
import { cx, PageHeader } from '@/components/ui';
import type { Session } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { EmailTab } from './EmailTab';
import { IntegrationsTab } from './IntegrationsTab';
import { NotificationsTab } from './NotificationsTab';
import { OrgsTab } from './OrgsTab';
import { PeopleTab } from './PeopleTab';
import { PoliciesTab } from './PoliciesTab';
import { ProfileTab } from './ProfileTab';
import { TemplatesTab } from './TemplatesTab';

interface TabDef {
  slug: string;
  label: string;
  icon: LucideIcon;
  allowed: (s: Session | null) => boolean;
  render: () => React.ReactNode;
}

const TABS: { group: string; tabs: TabDef[] }[] = [
  {
    group: 'Your firm',
    tabs: [
      {
        slug: 'people',
        label: 'People',
        icon: Users,
        allowed: (s) => hasPerm(s, 'users:write'),
        render: () => <PeopleTab />,
      },
      {
        slug: 'organizations',
        label: 'Vendors & owners',
        icon: Building2,
        allowed: (s) => hasPerm(s, 'users:write'),
        render: () => <OrgsTab />,
      },
      {
        slug: 'approvals',
        label: 'Approval policies',
        icon: BadgeCheck,
        allowed: (s) => hasPerm(s, 'approval_policies:write'),
        render: () => <PoliciesTab />,
      },
      {
        slug: 'templates',
        label: 'Task templates',
        icon: ListChecks,
        allowed: (s) => hasPerm(s, 'templates:write'),
        render: () => <TemplatesTab />,
      },
      {
        slug: 'email',
        label: 'Email',
        icon: Mail,
        allowed: (s) => hasPerm(s, 'org:admin'),
        render: () => <EmailTab />,
      },
      {
        slug: 'integrations',
        label: 'Integrations',
        icon: PlugZap,
        allowed: (s) => hasPerm(s, 'org:admin') || hasPerm(s, 'integrations:write'),
        render: () => <IntegrationsTab />,
      },
    ],
  },
  {
    group: 'You',
    tabs: [
      {
        slug: 'profile',
        label: 'Profile',
        icon: UserRound,
        allowed: () => true,
        render: () => <ProfileTab />,
      },
      {
        slug: 'notifications',
        label: 'Notifications',
        icon: Bell,
        allowed: () => true,
        render: () => <NotificationsTab />,
      },
    ],
  },
];

export function Component() {
  const s = useSession();
  const { tab } = useParams();
  const groups = TABS.map((g) => ({ ...g, tabs: g.tabs.filter((t) => t.allowed(s)) })).filter(
    (g) => g.tabs.length,
  );
  const all = groups.flatMap((g) => g.tabs);
  const current = all.find((t) => t.slug === tab);
  if (!current) return <Navigate to={`/app/settings/${all[0]!.slug}`} replace />;

  return (
    <>
      <PageHeader
        title="Settings"
        description={
          all.length > 2
            ? `How ${s?.context.orgName ?? 'your firm'} works in Pro-Cure: people, partners, rules and connections.`
            : 'Your profile and how Pro-Cure keeps you informed.'
        }
      />
      <div className="mx-auto grid max-w-[1320px] grid-cols-[minmax(0,1fr)] gap-6 px-4 py-5 sm:px-6 lg:grid-cols-[200px_minmax(0,1fr)]">
        <nav aria-label="Settings" className="lg:sticky lg:top-[4.75rem] lg:self-start">
          {/* phone/tablet: one scrollable row; desktop: grouped column */}
          <div className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-1 lg:mx-0 lg:block lg:space-y-4 lg:overflow-visible lg:px-0">
            {groups.map((g) => (
              <div key={g.group} className="contents lg:block">
                <div className="hidden px-2.5 pb-1 text-[12px] text-ink-3 lg:block">{g.group}</div>
                <div className="contents lg:block lg:space-y-0.5">
                  {g.tabs.map((t) => (
                    <NavLink
                      key={t.slug}
                      to={`/app/settings/${t.slug}`}
                      className={({ isActive }) =>
                        cx(
                          'flex h-8 shrink-0 items-center gap-2 rounded-sm px-2.5 text-[13.5px] font-[540] whitespace-nowrap',
                          isActive
                            ? 'bg-paper text-ink shadow-[inset_2px_0_0_var(--color-brass)] ring-1 ring-line'
                            : 'text-ink-2 hover:bg-stone-2 hover:text-ink',
                        )
                      }
                    >
                      <t.icon className="size-4 text-ink-3" />
                      {t.label}
                    </NavLink>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </nav>
        <div className="min-w-0">{current.render()}</div>
      </div>
    </>
  );
}
