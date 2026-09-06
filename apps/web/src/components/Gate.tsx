import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useSession } from '../lib/session.js';
import { Loading } from './Feedback.js';

/**
 * Renders children only if the user holds the key.
 *
 * "A user never sees a tile or action they cannot use" (MVP_SCREEN_LIST §1).
 * Hiding rather than disabling is deliberate: a greyed-out Approve button
 * teaches a site engineer that the product is refusing them, and they ask the
 * PM why. An absent button teaches nothing and asks nothing.
 *
 * The server enforces regardless. This is presentation.
 */
export function Can({ perm, projectId, children, otherwise = null }: {
  /**
   * Named `perm`, not `key`. `key` is reserved by React: the reconciler
   * consumes it and it never reaches the component, so <Can key="..."> would
   * silently render nothing and every gated control would vanish for everyone.
   */
  perm: string;
  projectId?: string | null;
  children: ReactNode;
  otherwise?: ReactNode;
}) {
  const { can } = useSession();
  return <>{can(perm, projectId) ? children : otherwise}</>;
}

/** Route guard: authenticated, and optionally holding a key. */
export function Protected({ children, require: required, to = '/login' }: {
  children: ReactNode; require?: string; to?: string;
}) {
  const { me, loading, can } = useSession();
  const loc = useLocation();
  if (loading) return <Loading label="Checking your access" />;
  if (!me) return <Navigate to={to} replace state={{ from: loc.pathname }} />;
  if (required && !can(required)) {
    return (
      <div className="banner banner-warn" role="alert">
        <div className="stack-2">
          <strong>You do not have access to this screen</strong>
          <span className="small">
            It needs the <code>{required}</code> permission. Your project manager
            or company administrator can grant it.
          </span>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
