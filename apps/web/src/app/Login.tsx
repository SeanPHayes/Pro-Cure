import { useQuery } from '@tanstack/react-query';
import { Building2, Factory, Hotel } from 'lucide-react';
import { useState } from 'react';
import { Navigate } from 'react-router';
import { Avatar, Button, cx, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { homeFor, useAuthActions, useSession } from '@/lib/auth';
import { humanize } from '@/lib/format';

interface DevUser {
  id: string;
  email: string;
  name: string;
  title: string | null;
  orgName: string;
  orgType: string;
  roles: string[];
}

const GROUPS = [
  { type: 'procurement_firm', label: 'Procurement team', icon: Building2 },
  { type: 'vendor', label: 'Vendors', icon: Factory },
  { type: 'client', label: 'Hotel owners', icon: Hotel },
] as const;

/** A guestroom floor plan in brass hairlines — the subject of every project in the system. */
function PlanDrawing() {
  return (
    <svg
      viewBox="0 0 420 300"
      className="w-full max-w-[460px]"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      aria-hidden
    >
      <rect x="10" y="10" width="400" height="280" />
      <path d="M10 200h120v90M130 200v-40h-40" />
      <path d="M270 10v70h140" />
      <rect x="170" y="120" width="140" height="120" rx="3" />
      <rect x="182" y="128" width="54" height="22" rx="4" />
      <rect x="244" y="128" width="54" height="22" rx="4" />
      <path d="M170 160h140" strokeDasharray="3 4" />
      <rect x="140" y="128" width="26" height="26" />
      <rect x="314" y="128" width="26" height="26" />
      <circle cx="153" cy="141" r="6" />
      <circle cx="327" cy="141" r="6" />
      <rect x="290" y="250" width="110" height="30" />
      <path d="M300 250v-14h22v14M340 236h22v14" />
      <rect x="28" y="28" width="70" height="44" />
      <path d="M28 50h70" />
      <circle cx="355" cy="45" r="22" />
      <circle cx="355" cy="45" r="8" />
      <path d="M130 290a50 50 0 0 1 50-50" strokeDasharray="2 3" />
      <path d="M20 120h80M60 110v20" />
    </svg>
  );
}

export function Login() {
  const session = useSession();
  const { devLogin } = useAuthActions();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const users = useQuery({
    queryKey: ['dev-users'],
    queryFn: () => api.get<DevUser[]>('identity', '/auth/dev/users'),
    retry: false,
    meta: { silent: true },
  });

  if (session) return <Navigate to={homeFor(session)} replace />;

  const signIn = async (u: DevUser) => {
    setBusy(u.id);
    setError(null);
    try {
      await devLogin(u.email);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  };

  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-lacquer p-10 text-white lg:sticky lg:top-0 lg:flex lg:h-dvh">
        <div className="text-[15px] font-[620] tracking-tight text-brass-400">Pro-Cure</div>
        <div className="text-brass-400/80">
          <PlanDrawing />
        </div>
        <div>
          <p className="max-w-[24ch] text-[34px] leading-[1.1] font-[600] tracking-[-0.02em]">
            Every room, every piece, from spec to install.
          </p>
          <p className="mt-4 max-w-[46ch] text-white/70">
            Quotes built by room type, vendors pricing in their own portal, and owners watching their
            deliveries arrive — in one place.
          </p>
        </div>
      </aside>

      <main className="flex flex-col px-6 py-10 sm:px-12">
        <div className="mx-auto w-full max-w-[560px]">
          <h1 className="text-[24px] font-[640]">Sign in</h1>
          <p className="mt-1 text-ink-2">
            This is a demo environment. Choose a person to see Pro-Cure the way they see it.
          </p>

          {error && <p className="mt-4 rounded-sm bg-crit-50 px-3 py-2 text-crit">{error}</p>}

          {users.isLoading ? (
            <div className="mt-10 flex justify-center">
              <Spinner />
            </div>
          ) : users.isError ? (
            <div className="mt-8 rounded-sm border border-line bg-paper p-4 text-ink-2">
              Demo sign-in isn’t available. Start the API with <code>pnpm dev</code>, or use single sign-on.
            </div>
          ) : (
            <div className="mt-8 space-y-7">
              {GROUPS.map((g) => {
                const list = (users.data ?? []).filter((u) => u.orgType === g.type);
                if (!list.length) return null;
                return (
                  <section key={g.type}>
                    <h2 className="mb-2 flex items-center gap-2 text-[13px] font-[620] text-ink-2">
                      <g.icon className="size-4" />
                      {g.label}
                    </h2>
                    <ul className="divide-y divide-line-2 rounded-md border border-line bg-paper">
                      {list.map((u) => (
                        <li key={u.id}>
                          <button
                            type="button"
                            onClick={() => signIn(u)}
                            disabled={!!busy}
                            className={cx(
                              'flex w-full items-center gap-3 px-3.5 py-2.5 text-left hover:bg-stone disabled:opacity-60',
                              busy === u.id && 'bg-brass-50',
                            )}
                          >
                            <Avatar
                              name={u.name}
                              tone={g.type === 'procurement_firm' ? 'lacquer' : 'brass'}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block font-[560]">{u.name}</span>
                              <span className="block truncate text-[13px] text-ink-3">
                                {u.title ?? humanize(u.roles[0])}, {u.orgName}
                              </span>
                            </span>
                            {busy === u.id ? <Spinner className="size-4" /> : null}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
          )}

          {import.meta.env.VITE_COGNITO_DOMAIN && (
            <div className="mt-8 border-t border-line pt-6">
              <Button
                variant="secondary"
                className="w-full"
                onClick={() => {
                  window.location.href = `${import.meta.env.VITE_COGNITO_DOMAIN}/oauth2/authorize?response_type=code&client_id=${import.meta.env.VITE_COGNITO_CLIENT_ID}&redirect_uri=${encodeURIComponent(`${window.location.origin}/auth/callback`)}&scope=openid+email+profile`;
                }}
              >
                Sign in with your company account
              </Button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
