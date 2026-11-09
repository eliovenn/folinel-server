import { and, eq, sql } from 'drizzle-orm';

import type { Database, Transaction } from '../../db/client.ts';
import { blockedEmailDomain, registrationAttempt, user } from '../../db/schema.ts';
import { HttpError } from '../../http/errors.ts';
import { matchesBlockedDomain } from './validation.ts';

/** 跨进程串行化同一邮箱的注册、重发与验证，锁随事务释放。 */
export async function lockRegistration(tx: Transaction, email: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`registration:${email}`}, 0))`);
}

export async function assertEmailAllowed(db: Database | Transaction, email: string) {
  const domain = email.slice(email.lastIndexOf('@') + 1);
  const rules = await db.select({ domain: blockedEmailDomain.domain }).from(blockedEmailDomain).where(eq(blockedEmailDomain.enabled, true));
  if (rules.some((rule) => matchesBlockedDomain(domain, rule.domain))) {
    throw new HttpError(403, 'EMAIL_DOMAIN_BLOCKED', '该邮箱域名暂不支持注册，请更换邮箱。');
  }
}

export async function findPendingRegistration(tx: Transaction, email: string, id: string) {
  const [pending] = await tx.select({ userId: user.id }).from(registrationAttempt)
    .innerJoin(user, eq(registrationAttempt.userId, user.id))
    .where(and(eq(registrationAttempt.id, id), eq(user.email, email), eq(user.emailVerified, false)));
  if (!pending) throw new HttpError(400, 'REGISTRATION_INVALID', '注册申请无效，请重新开始注册。');
  return pending;
}
