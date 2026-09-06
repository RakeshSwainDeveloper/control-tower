import type { Page, APIRequestContext } from '@playwright/test';

export const API = process.env['E2E_API_URL'] ?? 'http://api:3000/api/v1';

export const DEMO = {
  admin: 'nikhil@demo.test',
  management: 'mehta@demo.test',
  pm: 'vikram@demo.test',
  engineer: 'anita@demo.test',
  password: 'Demo!Passw0rd',
  supervisorPhone: '+919000000001',
} as const;

/**
 * Sign in through the API and hand the tokens to the page.
 *
 * Driving the login form in every test would test the login form nine times
 * and the journey once. J1 and J7 exercise the form itself; everything else
 * starts authenticated, which is where the journey actually begins.
 */
export async function signIn(page: Page, request: APIRequestContext, email: string) {
  const res = await request.post(`${API}/auth/login`, {
    data: { email, password: DEMO.password },
    headers: { 'x-device-id': 'e2e' },
  });
  const body = await res.json() as { access_token: string; refresh_token: string };
  await page.addInitScript(([a, r]) => {
    sessionStorage.setItem('ct.access', a!);
    sessionStorage.setItem('ct.refresh', r!);
  }, [body.access_token, body.refresh_token]);
}

/** The supervisor signs in by phone; the dev code comes back in the response. */
export async function signInSupervisor(page: Page, request: APIRequestContext) {
  const otp = await request.post(`${API}/auth/otp/request`, {
    data: { phone: DEMO.supervisorPhone },
  });
  const { dev_code } = await otp.json() as { dev_code: string };
  const res = await request.post(`${API}/auth/otp/verify`, {
    data: { phone: DEMO.supervisorPhone, code: dev_code },
    headers: { 'x-device-id': 'e2e-phone' },
  });
  const body = await res.json() as { access_token: string; refresh_token: string };
  await page.addInitScript(([a, r]) => {
    sessionStorage.setItem('ct.access', a!);
    sessionStorage.setItem('ct.refresh', r!);
  }, [body.access_token, body.refresh_token]);
  return dev_code;
}
