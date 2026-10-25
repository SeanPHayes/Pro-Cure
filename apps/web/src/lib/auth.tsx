import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router';
import { api, getSession, onSession, type Session, setSession, toSession } from './api';

export const useSession = (): Session | null =>
  useSyncExternalStore(
    (cb) => onSession(cb),
    () => getSession(),
  );

/** The session, asserting the user is signed in (used inside authenticated shells). */
export const useMe = (): Session => {
  const s = useSession();
  if (!s) throw new Error('Not signed in');
  return s;
};

export const homeFor = (s: Session | null) =>
  !s
    ? '/login'
    : s.context.actor === 'vendor'
      ? '/vendor'
      : s.context.actor === 'client'
        ? '/portal'
        : '/app';

export function useAuthActions() {
  const qc = useQueryClient();
  const nav = useNavigate();

  const devLogin = useCallback(
    async (email: string) => {
      const r = await api.post<any>('identity', '/auth/dev/login', { email });
      qc.clear();
      const s = toSession(r);
      setSession(s);
      nav(homeFor(s), { replace: true });
    },
    [qc, nav],
  );

  const switchContext = useCallback(
    async (orgId: string, tenantId: string) => {
      const r = await api.post<any>('identity', '/auth/switch', { orgId, tenantId });
      qc.clear();
      const s = toSession(r);
      setSession(s);
      nav(homeFor(s), { replace: true });
    },
    [qc, nav],
  );

  const signOut = useCallback(async () => {
    const s = getSession();
    try {
      if (s) await api.post('identity', '/auth/logout', { refreshToken: s.refreshToken });
    } catch {
      /* already invalid */
    }
    setSession(null);
    qc.clear();
    nav('/login', { replace: true });
  }, [qc, nav]);

  return { devLogin, switchContext, signOut };
}

export const hasPerm = (s: Session | null, p: string) => !!s?.context.permissions.includes(p);
