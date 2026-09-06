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
    <Centred>
      <form className="card card-p stack" onSubmit={submit} style={{ width: 'min(24rem, 100%)' }}>
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
            style={{ width: 'min(24rem, 100%)' }}>
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
      <form className="card card-p stack" onSubmit={submit} style={{ width: 'min(24rem, 100%)' }}>
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

function Brand({ subtitle }: { subtitle: string }) {
  return (
    <div className="row" style={{ gap: 'var(--s3)' }}>
      <span aria-hidden style={{
        width: 40, height: 40, borderRadius: 8, flex: 'none',
        background: 'linear-gradient(135deg, var(--primary), var(--accent))',
      }} />
      <div className="stack-2" style={{ gap: 0 }}>
        <strong style={{ fontSize: 'var(--text-lg)' }}>Control Tower</strong>
        <span className="small muted">{subtitle}</span>
      </div>
    </div>
  );
}

function Centred({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={className} style={{
      minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 'var(--s5)',
    }}>
      {children}
    </div>
  );
}
