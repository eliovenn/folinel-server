import { z } from 'zod';

export const emailSchema = z.string().trim().max(254).toLowerCase().pipe(z.email());
export const registerSchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(8).max(128),
});
export const resendSchema = z.strictObject({
  email: emailSchema,
  registrationId: z.uuid(),
});
export const verifyRegistrationSchema = resendSchema.extend({ otp: z.string().regex(/^\d{6}$/) });

export function matchesBlockedDomain(domain: string, blocked: string): boolean {
  const normalized = domain.toLowerCase();
  const rule = blocked.toLowerCase();
  return normalized === rule || normalized.endsWith(`.${rule}`);
}
