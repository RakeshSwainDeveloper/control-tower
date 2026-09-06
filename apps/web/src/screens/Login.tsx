import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ArrowRight, KeyRound, Smartphone } from 'lucide-react';
import { api, ApiError } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { ErrorBanner, Loading } from '../components/Feedback.js';

interface TokenPair { access_token: string; refresh_token: string }

/**
 * Two doors into the same product.
 *
 * S-W01 — office users sign in with email and password.
 * S-M01 — site users sign in with a phone number and a one-time code, because
 *         a supervisor on a shared site handset will not remember a password
 *         and will write it inside the phone case if made to have one.
 *
 * Which door a person sees is decided by the URL, not by a toggle they have to
 * understand. `/login` is the office; `/site/login` is the site. Each offers a
 * quiet link to the other for the minority who need it.
 */
export function OfficeLogin() {
  const { me, loading, signIn } = useSession();
  const nav = useNavigate();
  const loc = useLocation() as { state?: { from?: string } };
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  if (loading) return <Centred><Loading label="Checking your session" /></Centred>;
  if (me) return <Navigate to={loc.state?.from ?? '/'} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const t = await api.post<TokenPair>('/auth/login', { email, password });
      await signIn(t.access_token, t.refresh_token);
      nav(loc.state?.from ?? '/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError({ title: 'Sign-in failed', status: 0 }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Centred aside={ASIDE}>
      <form className="card card-p stack" onSubmit={submit}
            style={{ width: 'min(24rem, 100%)', boxShadow: 'var(--shadow-md)' }}>
        <Brand subtitle="Sign in to your organisation" />
        {error ? <ErrorBanner error={error} /> : null}
        <label className="field">
          <span className="label">Email</span>
          <input className="input" type="email" autoComplete="username" required
                 value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </label>
        <label className="field">
          <span className="label">Password</span>
          <input className="input" type="password" autoComplete="current-password" required
                 value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button className="btn btn-primary btn-block" type="submit" disabled={busy || !email || !password}>
          {busy ? <span className="spinner" aria-hidden /> : <KeyRound size={16} aria-hidden />}
          Sign in
        </button>
        <a href="/site/login" className="small muted" style={{ textAlign: 'center' }}>
          Working on site? Sign in with your phone
        </a>
        {/* The platform console is a different identity domain entirely: a
            platform account is structurally invalid here and returns 401. Say
            so, rather than letting somebody try their platform credentials on
            the tenant door and conclude the product is broken. */}
        <a href="/admin/login" className="xs muted" style={{ textAlign: 'center' }}>
          Platform administrator? Sign in here
        </a>
      </form>
    </Centred>
  );
}

export function SiteLogin() {
  const { me, loading, signIn } = useSession();
  const nav = useNavigate();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'phone' | 'code'>('phone');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  if (loading) return <Centred><Loading label="Checking your session" /></Centred>;
  if (me) return <Navigate to="/site" replace />;

  const requestCode = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post('/auth/otp/request', { phone });
      setStage('code');
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError({ title: 'Could not send the code', status: 0 }));
    } finally { setBusy(false); }
  };

  const verify = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const t = await api.post<TokenPair>('/auth/otp/verify', { phone, code });
      await signIn(t.access_token, t.refresh_token);
      nav('/site', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError({ title: 'Sign-in failed', status: 0 }));
    } finally { setBusy(false); }
  };

  return (
    <Centred className="site">
      <form className="card card-p stack" onSubmit={stage === 'phone' ? requestCode : verify}
            style={{ width: 'min(24rem, 100%)', boxShadow: 'var(--shadow-md)' }}>
        <Brand subtitle="Sign in with your phone" />
        {error ? <ErrorBanner error={error} /> : null}

        <label className="field">
          <span className="label">Mobile number</span>
          <input
            className="input" type="tel" inputMode="tel" autoComplete="tel" required
            value={phone} onChange={(e) => setPhone(e.target.value)}
            disabled={stage === 'code'} autoFocus placeholder="+91…"
          />
        </label>

        {stage === 'code' ? (
          <label className="field">
            <span className="label">Code sent to {phone}</span>
            {/* Numeric keypad, one-time-code autofill, and wide spacing: this is
                typed with one thumb, outdoors, possibly with gloves on. */}
            <input
              className="input" type="text" inputMode="numeric" autoComplete="one-time-code"
              pattern="[0-9]*" maxLength={8} required autoFocus
              value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              style={{ fontSize: 'var(--text-xl)', letterSpacing: '0.4em', textAlign: 'center' }}
            />
            <button type="button" className="btn btn-ghost btn-sm"
                    onClick={() => { setStage('phone'); setCode(''); }}>
              Use a different number
            </button>
          </label>
        ) : null}

        <button className="btn btn-primary btn-block" type="submit"
                disabled={busy || (stage === 'phone' ? phone.length < 8 : code.length < 4)}>
          {busy ? <span className="spinner" aria-hidden />
                : stage === 'phone' ? <Smartphone size={18} aria-hidden />
                : <ArrowRight size={18} aria-hidden />}
          {stage === 'phone' ? 'Send code' : 'Sign in'}
        </button>

        <a href="/login" className="small muted" style={{ textAlign: 'center' }}>
          Office user? Sign in with email
        </a>
      </form>
    </Centred>
  );
}

export function PlatformLogin() {
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const t = await api.post<TokenPair>('/platform/login', { email, password });
      // Platform tokens are NOT tenant tokens. They are kept under the same
      // storage keys because a browser is only ever one or the other, and the
      // tenant surface returns a clean 401 for a platform token (Phase 2).
      sessionStorage.setItem('ct.access', t.access_token);
      sessionStorage.setItem('ct.refresh', t.refresh_token);
      nav('/admin', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError({ title: 'Sign-in failed', status: 0 }));
    } finally { setBusy(false); }
  };

  return (
    <Centred>
      <form className="card card-p stack" onSubmit={submit}
            style={{ width: 'min(24rem, 100%)', boxShadow: 'var(--shadow-md)' }}>
        <div style={{ height: 3, background: 'var(--destructive)', borderRadius: 2 }} aria-hidden />
        <Brand subtitle="Platform administration" />
        {error ? <ErrorBanner error={error} /> : null}
        <label className="field">
          <span className="label">Email</span>
          <input className="input" type="email" autoComplete="username" required
                 value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </label>
        <label className="field">
          <span className="label">Password</span>
          <input className="input" type="password" autoComplete="current-password" required
                 value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
          {busy ? <span className="spinner" aria-hidden /> : <KeyRound size={16} aria-hidden />}
          Sign in
        </button>
      </form>
    </Centred>
  );
}

export function Mark({ size = 40 }: { size?: number }) {
  /**
   * The mark: a plumb bob over a base line. Drawn rather than gradient-filled
   * — a two-colour gradient square is what every SaaS starter ships, and this
   * product is for people who measure things.
   */
  return (
    <span aria-hidden style={{
      width: size, height: size, flex: 'none', borderRadius: size * 0.24,
      background: 'var(--primary)', display: 'grid', placeItems: 'center',
      boxShadow: 'var(--shadow-sm), inset 0 1px 0 rgb(255 255 255 / 0.12)',
    }}>
      <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 24 24" fill="none">
        <path d="M12 2v7" stroke="#7dd3fc" strokeWidth="1.6" strokeLinecap="round" />
        <path d="m12 9 4 5-4 6-4-6 4-5Z" fill="#38bdf8" />
        <path d="M4 22h16" stroke="#7dd3fc" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    </span>
  );
}

function Brand({ subtitle }: { subtitle: string }) {
  return (
    <div className="row" style={{ gap: 'var(--s3)' }}>
      <Mark />
      <div className="stack-2" style={{ gap: 0 }}>
        <strong style={{ fontSize: 'var(--text-lg)', letterSpacing: 'var(--track-tight)' }}>
          Control Tower
        </strong>
        <span className="small muted">{subtitle}</span>
      </div>
    </div>
  );
}

/**
 * A two-panel sign-in on desktop, a single centred card on a phone.
 *
 * The left panel is not decoration: it states what the product does, which is
 * the one moment a new site engineer has to read it. On the site surface the
 * panel is dropped entirely — a supervisor signing in on a phone at 7am wants
 * the number pad, not the pitch.
 */
function Centred({ children, className, aside }: {
  children: React.ReactNode; className?: string; aside?: React.ReactNode;
}) {
  return (
    <div className={className} style={{ minHeight: '100vh', display: 'flex' }}>
      {aside ? (
        <aside className="login-aside">
          {aside}
        </aside>
      ) : null}
      <div style={{
        flex: 1, display: 'grid', placeItems: 'center',
        padding: 'var(--s6) var(--s5)', minWidth: 0,
      }}>
        {children}
      </div>
    </div>
  );
}

const ASIDE = (
  <div className="stack" style={{ gap: 'var(--s6)', maxWidth: '26rem' }}>
    <Mark size={44} />
    <h2 style={{ fontSize: 'var(--text-2xl)', color: '#fff', letterSpacing: 'var(--track-tight)' }}>
      Know what is actually happening on site.
    </h2>
    <ul className="stack-2" style={{ gap: 'var(--s3)' }}>
      {[
        'Quantities recorded where the work is, with photographs',
        'Verified by a second person before they count',
        'Approvals, issues and the audit trail in one place',
      ].map((line) => (
        <li key={line} className="row" style={{ gap: 'var(--s3)', alignItems: 'flex-start' }}>
          <span aria-hidden style={{
            width: 6, height: 6, borderRadius: '50%', background: '#38bdf8',
            marginTop: 8, flex: 'none',
          }} />
          <span style={{ color: 'rgb(255 255 255 / 0.78)' }}>{line}</span>
        </li>
      ))}
    </ul>
  </div>
);
