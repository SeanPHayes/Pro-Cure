import { useQuery } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { ArrowLeftRight, LogOut, Menu as MenuIcon, Search, X } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { Avatar, cx, Menu } from '@/components/ui';
import { api, type Session } from '@/lib/api';
import { hasPerm, homeFor, useAuthActions, useSession } from '@/lib/auth';
import { humanize } from '@/lib/format';
import { Notifications } from './Notifications';
import { CLIENT_NAV, INTERNAL_NAV, type NavItem, requiredPerm, VENDOR_NAV } from './nav';

/** Route guard: renders children only for the right kind of actor; otherwise sends them home. */
export function RequireActor({
  actor,
  children,
}: {
  actor: 'internal' | 'vendor' | 'client';
  children: ReactNode;
}) {
  const s = useSession();
  const loc = useLocation();
  if (!s) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} replace />;
  const a = s.context.actor === 'platform' ? 'internal' : s.context.actor;
  if (a !== actor) return <Navigate to={homeFor(s)} replace />;
  return <>{children}</>;
}

export const RootRedirect = () => <Navigate to={homeFor(useSession())} replace />;

function Wordmark({ sub }: { sub: string }) {
  return (
    <div className="px-4 pt-4 pb-5">
      <div className="text-[16px] font-[660] tracking-[-0.01em] text-brass-400">Pro-Cure</div>
      <div className="mt-0.5 truncate text-[12px] text-white/60">{sub}</div>
    </div>
  );
}

function RailLink({ item, onNavigate }: { item: NavItem; onNavigate?: () => void }) {
  return (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onNavigate}
      className={({ isActive }) =>
        cx(
          'group flex h-8 items-center gap-2.5 rounded-sm px-2.5 text-[13.5px] font-[520] transition-colors',
          isActive ? 'bg-white/12 text-white' : 'text-white/72 hover:bg-white/6 hover:text-white',
        )
      }
    >
      {({ isActive }) => (
        <>
          <item.icon
            className={cx(
              'size-[17px]',
              isActive ? 'text-brass-400' : 'text-white/55 group-hover:text-white/80',
            )}
          />
          {item.label}
        </>
      )}
    </NavLink>
  );
}

function UserMenu({ s }: { s: Session }) {
  const { signOut, switchContext } = useAuthActions();
  const others = s.contexts.filter(
    (c) => !(c.orgId === s.context.orgId && c.tenantId === s.context.tenantId),
  );
  return (
    <Menu
      trigger={(toggle) => (
        <button
          type="button"
          onClick={toggle}
          className="flex items-center gap-2 rounded-sm py-1 pr-2 pl-1 hover:bg-stone-2"
          aria-label="Account menu"
        >
          <Avatar name={s.user.name} size={28} />
          <span className="hidden text-left leading-tight md:block">
            <span className="block text-[13px] font-[560]">{s.user.name}</span>
            <span className="block text-[12px] text-ink-3">
              {humanize(s.context.roles[0] ?? s.context.actor)}
            </span>
          </span>
        </button>
      )}
      items={[
        ...others.map((c) => ({
          label: `Switch to ${c.orgName}${c.tenantName !== c.orgName ? ` (${c.tenantName})` : ''}`,
          icon: <ArrowLeftRight className="size-4 text-ink-3" />,
          onSelect: () => switchContext(c.orgId, c.tenantId),
        })),
        ...(others.length ? (['divider'] as const) : []),
        { label: 'Sign out', icon: <LogOut className="size-4 text-ink-3" />, onSelect: signOut },
      ]}
    />
  );
}

/** ⌘K: jump to any page or search projects, quotes, POs, specs and the catalog. */
function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const term = q.trim();
  const projects = useQuery({
    queryKey: ['cmdk-projects', term],
    queryFn: () => api.get<{ items: any[] }>('projects', '/projects', { q: term, limit: 6 }),
    enabled: open && term.length > 1,
    meta: { silent: true },
  });
  const orders = useQuery({
    queryKey: ['cmdk-orders', term],
    queryFn: () => api.get<{ items: any[] }>('orders', '/purchase-orders', { q: term, limit: 6 }),
    enabled: open && term.length > 1,
    meta: { silent: true },
  });
  const quotes = useQuery({
    queryKey: ['cmdk-quotes', term],
    queryFn: () => api.get<{ items: any[] }>('quoting', '/quotes', { q: term, limit: 6 }),
    enabled: open && term.length > 1,
    meta: { silent: true },
  });
  useEffect(() => {
    if (!open) setQ('');
  }, [open]);
  if (!open) return null;
  const go = (to: string) => {
    onClose();
    nav(to);
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-dismiss; Escape closes for keyboard users
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/25 px-4 pt-[12vh]"
      onMouseDown={onClose}
    >
      <Command
        label="Command menu"
        shouldFilter={false}
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-[620px] overflow-hidden rounded-md border border-line bg-paper shadow-[var(--shadow-pop)]"
      >
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Search className="size-4 text-ink-3" />
          <Command.Input
            autoFocus
            value={q}
            onValueChange={setQ}
            placeholder="Search projects, quotes, POs, or jump to a page"
            className="h-12 flex-1 bg-transparent outline-none placeholder:text-ink-4"
          />
          <kbd className="rounded-xs border border-line px-1.5 text-[11px] text-ink-3">esc</kbd>
        </div>
        <Command.List className="max-h-[400px] overflow-y-auto p-1.5 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[12px] [&_[cmdk-group-heading]]:text-ink-3">
          <Command.Empty className="px-3 py-8 text-center text-ink-3">No matches.</Command.Empty>
          {(projects.data?.items ?? []).length > 0 && (
            <Command.Group heading="Projects">
              {projects.data!.items.map((p) => (
                <PaletteItem
                  key={p.id}
                  onSelect={() => go(`/app/projects/${p.id}`)}
                  title={p.name}
                  meta={p.number}
                />
              ))}
            </Command.Group>
          )}
          {(quotes.data?.items ?? []).length > 0 && (
            <Command.Group heading="Quotes">
              {quotes.data!.items.map((x) => (
                <PaletteItem
                  key={x.id}
                  onSelect={() => go(`/app/quotes/${x.id}`)}
                  title={x.name}
                  meta={x.number}
                />
              ))}
            </Command.Group>
          )}
          {(orders.data?.items ?? []).length > 0 && (
            <Command.Group heading="Purchase orders">
              {orders.data!.items.map((x) => (
                <PaletteItem
                  key={x.id}
                  onSelect={() => go(`/app/orders/${x.id}`)}
                  title={`${x.number} · ${x.vendorName}`}
                  meta={x.projectName}
                />
              ))}
            </Command.Group>
          )}
          <Command.Group heading="Go to">
            {INTERNAL_NAV.flatMap((g) => g.items)
              .filter((i) => !term || i.label.toLowerCase().includes(term.toLowerCase()))
              .map((i) => (
                <PaletteItem
                  key={i.to}
                  onSelect={() => go(i.to)}
                  title={i.label}
                  icon={<i.icon className="size-4" />}
                />
              ))}
          </Command.Group>
        </Command.List>
      </Command>
    </div>
  );
}

const PaletteItem = ({
  title,
  meta,
  icon,
  onSelect,
}: {
  title: string;
  meta?: string;
  icon?: ReactNode;
  onSelect: () => void;
}) => (
  <Command.Item
    onSelect={onSelect}
    className="flex cursor-pointer items-center gap-2.5 rounded-sm px-2.5 py-2 text-ink aria-selected:bg-lacquer-50"
  >
    {icon && <span className="text-ink-3">{icon}</span>}
    <span className="flex-1 truncate">{title}</span>
    {meta && <span className="text-[12px] text-ink-3">{meta}</span>}
  </Command.Item>
);

function Shell({
  rail,
  railSub,
  topLeft,
}: {
  rail: (close: () => void) => ReactNode;
  railSub: string;
  topLeft?: ReactNode;
}) {
  const s = useSession()!;
  const [mobileNav, setMobileNav] = useState(false);
  const loc = useLocation();
  // biome-ignore lint/correctness/useExhaustiveDependencies: close the drawer whenever the route changes
  useEffect(() => setMobileNav(false), [loc.pathname]);
  return (
    <div className="flex min-h-dvh">
      <aside
        className={cx(
          'fixed inset-y-0 left-0 z-40 flex w-[232px] flex-col bg-lacquer transition-transform lg:sticky lg:top-0 lg:h-dvh lg:translate-x-0',
          mobileNav ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-start justify-between">
          <Wordmark sub={railSub} />
          <button
            type="button"
            className="mt-3 mr-2 grid size-8 place-items-center text-white/70 lg:hidden"
            onClick={() => setMobileNav(false)}
            aria-label="Close navigation"
          >
            <X className="size-4" />
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto px-2 pb-4">{rail(() => setMobileNav(false))}</nav>
      </aside>
      {mobileNav && (
        <button
          type="button"
          aria-label="Close navigation"
          className="fixed inset-0 z-30 bg-ink/30 lg:hidden"
          onClick={() => setMobileNav(false)}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-paper/95 px-4 backdrop-blur">
          <button
            type="button"
            className="grid size-9 place-items-center rounded-sm text-ink-2 hover:bg-stone-2 lg:hidden"
            onClick={() => setMobileNav(true)}
            aria-label="Open navigation"
          >
            <MenuIcon className="size-5" />
          </button>
          <div className="min-w-0 flex-1">{topLeft}</div>
          <Notifications />
          <UserMenu s={s} />
        </header>
        <main className="min-w-0 flex-1">
          <PermissionGate />
        </main>
      </div>
    </div>
  );
}

/** Direct links to a page the user's role can't use get a clear message instead of a half-empty page. */
function PermissionGate() {
  const s = useSession()!;
  const { pathname } = useLocation();
  const perm = requiredPerm(pathname);
  if (perm && !hasPerm(s, perm))
    return (
      <div className="mx-auto max-w-[560px] px-6 py-24">
        <h1 className="text-[22px] font-[640]">You don't have access to this page</h1>
        <p className="mt-2 text-ink-2">
          Your role doesn't include it. Ask an administrator if you need access.
        </p>
      </div>
    );
  return <Outlet />;
}

export function InternalShell() {
  const s = useSession()!;
  const [palette, setPalette] = useState(false);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  return (
    <>
      <Shell
        railSub={s.context.orgName}
        rail={(close) => (
          <div className="space-y-4">
            {INTERNAL_NAV.map((g, i) => {
              const items = g.items.filter((it) => !it.perm || hasPerm(s, it.perm));
              if (!items.length) return null;
              return (
                <div key={g.label ?? `g${i}`}>
                  {g.label && <div className="px-2.5 pb-1 text-[12px] text-white/45">{g.label}</div>}
                  <div className="space-y-0.5">
                    {items.map((it) => (
                      <RailLink key={it.to} item={it} onNavigate={close} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        topLeft={
          <button
            type="button"
            onClick={() => setPalette(true)}
            className="flex h-9 w-full max-w-[420px] items-center gap-2 rounded-sm border border-line bg-stone px-3 text-ink-3 hover:border-ink-4"
          >
            <Search className="size-4" />
            <span className="flex-1 text-left">Search or jump to…</span>
            <kbd className="hidden rounded-xs border border-line bg-paper px-1.5 text-[11px] sm:inline">
              ⌘K
            </kbd>
          </button>
        }
      />
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </>
  );
}

export function VendorShell() {
  const s = useSession()!;
  return (
    <Shell
      railSub={`${s.context.orgName} · vendor portal`}
      rail={(close) => (
        <div className="space-y-0.5">
          {VENDOR_NAV.map((it) => (
            <RailLink key={it.to} item={it} onNavigate={close} />
          ))}
        </div>
      )}
      topLeft={
        <span className="text-ink-2">
          Working with{' '}
          <span className="font-[620] text-ink">
            {s.contexts.find((c) => c.tenantId === s.context.tenantId)?.tenantName}
          </span>
        </span>
      }
    />
  );
}

export function ClientShell() {
  const s = useSession()!;
  return (
    <Shell
      railSub={s.context.orgName}
      rail={(close) => (
        <div className="space-y-0.5">
          {CLIENT_NAV.map((it) => (
            <RailLink key={it.to} item={it} onNavigate={close} />
          ))}
        </div>
      )}
      topLeft={
        <span className="text-ink-2">
          Your projects with{' '}
          <span className="font-[620] text-ink">
            {s.contexts.find((c) => c.tenantId === s.context.tenantId)?.tenantName}
          </span>
        </span>
      }
    />
  );
}
