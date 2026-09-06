/**
 * A rule the user cannot read is worse than no rule.
 *
 * Twelve business rules in this schema are enforced by database triggers with
 * `RAISE EXCEPTION … USING ERRCODE = 'check_violation'`, and every message is
 * written for the person who will read it. Until Phase 7 all twelve surfaced
 * as a bare 500 with no detail: the rule fired correctly and the user was told
 * nothing, so they could not work out what to fix.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = new URL('../../../packages/db/migrations', import.meta.url).pathname;
const FILTER = (() => {
  const dir = new URL('../src/common', import.meta.url).pathname;
  const name = readdirSync(dir).find((f) => f.includes('filter') && f.endsWith('.ts'))!;
  return readFileSync(join(dir, name), 'utf8');
})();

describe('database rules reach the user', () => {
  it('the filter translates a trigger RAISE into a 4xx carrying its message', () => {
    expect(FILTER).toMatch(/isTriggerRule/);
    expect(FILTER).toMatch(/23514/);
    expect(FILTER).toMatch(/HttpStatus\.CONFLICT/);
  });

  it('a real column CHECK is NOT echoed to the user', () => {
    // A genuine CHECK carries a constraint name and a message written for a
    // DBA. Only a trigger's RAISE — which has no constraint and a message
    // written for a person — is ever shown.
    const fn = FILTER.slice(FILTER.indexOf('function isTriggerRule'));
    expect(fn).toMatch(/!err\.constraint/);
  });

  it('every trigger RAISE in the schema is phrased for a human', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))) {
      const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
      const re = /RAISE EXCEPTION\s*\n?\s*'([^']+)'/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(sql))) {
        const msg = m[1]!;
        // A message the user will read should be a sentence, not an identifier
        // or a bare column name.
        if (msg.length < 15 || !/[a-z]\s[a-z]/i.test(msg)) {
          offenders.push(`${file}: "${msg}"`);
        }
      }
    }
    expect(offenders, `messages that read like internals:\n${offenders.join('\n')}`).toEqual([]);
  });
});
