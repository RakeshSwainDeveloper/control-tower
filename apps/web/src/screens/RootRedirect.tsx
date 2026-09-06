import { lazy, Suspense } from 'react';
import { Navigate } from 'react-router-dom';
import { useSession } from '../lib/session.js';
import { Loading } from '../components/Feedback.js';

// Lazy: none of the landing page's markup or stylesheet reaches a signed-in
// supervisor's phone.
const Landing = lazy(async () => ({
  default: (await import('./landing/Landing.js')).Landing,
}));

/**
 * Where does "/" go?
 *
 * A site supervisor and a project manager are the same product and different
 * jobs. Rather than asking, route by what the person can actually do: someone
 * who can record progress but not read a dashboard is on site, and sending
 * them to an office dashboard they cannot open is a bad first second.
 */
export function RootRedirect() {
  const { me, loading, can } = useSession();
  if (loading) return <Loading label="Signing you in" />;
  /**
   * A signed-out visitor gets the public landing page; a signed-in one is
   * routed to their surface exactly as before. The redirect behaviour for
   * authenticated users is unchanged — only the anonymous case, which used to
   * bounce straight to /login, now has something to read first.
   */
  if (!me) {
    return (
      <Suspense fallback={<Loading label="Loading" />}>
        <Landing />
      </Suspense>
    );
  }
  const office = can('report.dashboard.read') || can('project.project.update') || can('org.user.read');
  return <Navigate to={office ? '/office' : '/site'} replace />;
}
