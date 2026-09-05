import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(256),
});
export type LoginDto = z.infer<typeof loginSchema>;

export const otpRequestSchema = z.object({
  // E.164-ish. Kept permissive: rejecting a valid international number at the
  // login form is worse than accepting one that simply will not match a user.
  phone: z.string().regex(/^\+?[0-9]{8,15}$/, 'Enter a valid phone number'),
});

export const otpVerifySchema = z.object({
  phone: z.string().regex(/^\+?[0-9]{8,15}$/),
  code: z.string().regex(/^[0-9]{4,8}$/),
});

export const refreshSchema = z.object({
  refresh_token: z.string().min(20).max(512),
});
