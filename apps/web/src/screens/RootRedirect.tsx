import { Navigate } from 'react-router-dom';
import { useSession } from '../lib/session.js';
import { Loading } from '../components/Feedback.js';

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
  if (!me) return <Navigate to="/login" replace />;
  const office = can('report.dashboard.read') || can('project.project.update') || can('org.user.read');
  return <Navigate to={office ? '/office' : '/site'} replace />;
}
