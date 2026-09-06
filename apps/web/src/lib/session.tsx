import {
  createContext, useContext, useCallback, useEffect, useMemo, useState,
  type ReactNode,
} from 'react';
import { api, tokens, ApiError } from './api.js';

export interface GrantedKey {
  key: string;
  org_wide: boolean;
  project_ids: string[];
  qualifier: string;
  responsibility: string;
}

export interface Me {
  user_id: string;
  org_id: string;
  permission_version: number;
  permissions: GrantedKey[];
  catalogue_size: number;
}

export interface ProjectSummary { id: string; code: string; name: string; status?: string }

interface SessionValue {
  me: Me | null;
  loading: boolean;
  projects: ProjectSummary[];
  projectId: string | null;
  setProjectId: (id: string) => void;
  /**
   * Does this user hold `key`, optionally on `projectId`?
   *
   * This HIDES UI. It is never the enforcement point — FR-564 — and every
   * screen still renders whatever the server refuses. A client-side check that
   * users believe is enforcement is how a product ends up with an API that
   * trusts its own front end.
   */
  can: (key: string, projectId?: string | null) => boolean;
  /** "as Project Manager" — the label the server will stamp on the record. */
  responsibilityFor: (key: string) => string | null;
  signIn: (access: string, refresh: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshMe: () => Promise<void>;
}

const Ctx = createContext<SessionValue | null>(null);
const PROJECT_KEY = 'ct.project';

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectId, setProjectIdState] = useState<string | null>(
    () => localStorage.getItem(PROJECT_KEY),
  );
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!tokens.access() && !tokens.refresh()) { setMe(null); setLoading(false); return; }
    try {
      const [meRes, projRes] = await Promise.all([
        api.get<Me>('/auth/me'),
        api.get<{ data: ProjectSummary[] }>('/projects?limit=100').catch(() => ({ data: [] })),
      ]);
      setMe(meRes);
      setProjects(projRes.data ?? []);
      setProjectIdState((current) => {
        const list = projRes.data ?? [];
        if (current && list.some((p) => p.id === current)) return current;
        // One project is the common case on a pilot: pick it rather than
        // making somebody choose from a list of one.
        return list.length > 0 ? list[0]!.id : null;
      });
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        tokens.clear();
        setMe(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const setProjectId = useCallback((id: string) => {
    localStorage.setItem(PROJECT_KEY, id);
    setProjectIdState(id);
  }, []);

  const byKey = useMemo(() => {
    const m = new Map<string, GrantedKey>();
    for (const g of me?.permissions ?? []) m.set(g.key, g);
    return m;
  }, [me]);

  const can = useCallback((key: string, pid?: string | null) => {
    const g = byKey.get(key);
    if (!g) return false;
    if (g.org_wide) return true;
    const target = pid === undefined ? projectId : pid;
    if (!target) return g.project_ids.length > 0;
    return g.project_ids.includes(target);
  }, [byKey, projectId]);

  const responsibilityFor = useCallback(
    (key: string) => byKey.get(key)?.responsibility ?? null, [byKey]);

  const signIn = useCallback(async (access: string, refresh: string) => {
    tokens.set(access, refresh);
    setLoading(true);
    await load();
  }, [load]);

  const signOut = useCallback(async () => {
    try { await api.post('/auth/logout'); } catch { /* the session dies locally regardless */ }
    tokens.clear();
    setMe(null);
    setProjects([]);
  }, []);

  const value: SessionValue = {
    me, loading, projects, projectId, setProjectId,
    can, responsibilityFor, signIn, signOut, refreshMe: load,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}

/** The current project, or null before one is chosen. */
export function useProject(): ProjectSummary | null {
  const { projects, projectId } = useSession();
  return projects.find((p) => p.id === projectId) ?? null;
}
