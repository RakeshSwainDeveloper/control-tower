import { z } from 'zod';
import { MVP_SCOPE_TYPES, MVP_RECORD_QUALIFIERS, PERMISSION_KEYS } from '@ct/contracts';

export const createUserSchema = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email().max(320).optional(),
  phone: z.string().regex(/^\+?[0-9]{8,15}$/).optional(),
  locale: z.string().max(10).default('en'),
}).refine((v) => v.email || v.phone, {
  message: 'A user needs an email or a phone number',
  path: ['email'],
});

export const listUsersSchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  status: z.enum(['invited', 'active', 'suspended', 'deactivated']).optional(),
  q: z.string().max(120).optional(),
});

export const createRoleSchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_]{2,48}$/),
  name: z.string().min(2).max(120),
  description: z.string().max(500).optional(),
  scopeLevels: z.array(z.enum(MVP_SCOPE_TYPES as unknown as [string, ...string[]])).min(1),
  permissions: z.array(z.object({
    // Validated against the CODE catalogue, not a database lookup: a tenant
    // can never invent a key that nothing checks (FR-022).
    key: z.enum(PERMISSION_KEYS as unknown as [string, ...string[]]),
    qualifier: z.enum(MVP_RECORD_QUALIFIERS as unknown as [string, ...string[]])
      .default('all_in_scope'),
  })).min(1),
});

export const grantSchema = z.object({
  userId: z.string().uuid(),
  roleId: z.string().uuid(),
  scopeType: z.enum(MVP_SCOPE_TYPES as unknown as [string, ...string[]]),
  scopeId: z.string().uuid().optional(),
  responsibilityLabel: z.string().min(2).max(80).optional(),
  validTo: z.coerce.date().optional(),
}).refine((v) => (v.scopeType === 'org') === !v.scopeId, {
  message: "An org-scoped grant takes no scopeId; a project-scoped grant requires one",
  path: ['scopeId'],
});

export const inviteSchema = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email().max(320).optional(),
  phone: z.string().regex(/^\+?[0-9]{8,15}$/).optional(),
  grants: z.array(z.object({
    roleId: z.string().uuid(),
    scopeType: z.enum(MVP_SCOPE_TYPES as unknown as [string, ...string[]]),
    scopeId: z.string().uuid().optional(),
  })).default([]),
}).refine((v) => v.email || v.phone, {
  message: 'An invitation needs an email or a phone number',
  path: ['email'],
});

export const acceptInviteSchema = z.object({
  token: z.string().min(20).max(512),
  password: z.string().min(10).max(256).optional(),
});
