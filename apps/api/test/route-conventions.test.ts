/**
 * Every route declares its access rule.
 *
 * Phase 7 found that GET /me/work and GET /me/approvals returned 403 to
 * everyone. Both were written deliberately ungated, and the PermissionGuard is
 * fail-closed: an endpoint carrying none of the three decorators is refused,
 * which is correct. The controllers were wrong, and nothing noticed because
 * the Phase 6 tests exercise the SERVICES — no test had ever made the HTTP
 * call.
 *
 * This test reads the controller sources so it covers every route that exists
 * rather than every route somebody remembered to write a case for. It is a
 * lint, and it is deliberately dumb: a route either has one of the three
 * decorators in its block or it does not.
 *
 * The response-shape half of the same problem is checked over real HTTP in
 * http-contract.test.ts — a source scan cannot see what a service returns.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../src', import.meta.url).pathname;

function controllers(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...controllers(full));
    else if (name.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

const HTTP = /^\s*@(Get|Post|Patch|Put|Delete)\(/;
const RULE = /@(RequirePermission|NoPermissionRequired|Public)\s*\(/;

describe('route conventions', () => {
  const files = controllers(SRC);

  it('finds the controllers (a test that scans nothing proves nothing)', () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  it('every HTTP route declares RequirePermission, NoPermissionRequired or Public', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      const lines = src.split('\n');
      const rel = file.slice(SRC.length + 1);

      // A rule on the @Controller itself covers every route in it. The platform
      // controller is @Public() at class level: it opts out of the tenant guard
      // entirely and PlatformGuard applies the platform identity domain instead.
      const classRule = /@(RequirePermission|NoPermissionRequired|Public)\s*\([^)]*\)\s*\n\s*@Controller/.test(src);
      if (classRule) continue;

      for (let i = 0; i < lines.length; i++) {
        if (!HTTP.test(lines[i]!)) continue;

        // The access decorator may sit above or below the HTTP one — this
        // codebase mostly writes @Get then @RequirePermission — so scan the
        // whole contiguous decorator block around it, stopping at the first
        // line that is neither a decorator, a comment nor blank.
        const isFiller = (l: string) =>
          l === '' || l.startsWith('@') || l.startsWith('*') ||
          l.startsWith('/*') || l.startsWith('//');

        let found = false;
        for (let j = i; j >= 0 && (j === i || isFiller(lines[j]!.trim())); j--) {
          if (RULE.test(lines[j]!)) { found = true; break; }
        }
        for (let j = i; !found && j < lines.length && (j === i || isFiller(lines[j]!.trim())); j++) {
          if (RULE.test(lines[j]!)) { found = true; break; }
        }
        if (!found) offenders.push(`${rel}:${i + 1}  ${lines[i]!.trim()}`);
      }
    }

    expect(
      offenders,
      `routes with no declared access rule — each is a guaranteed 403:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

});
