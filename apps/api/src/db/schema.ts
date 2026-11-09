import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { user } from './auth-schema.ts';

export * from './auth-schema.ts';

export const registrationAttempt = pgTable('registration_attempt', {
  userId: text('user_id').primaryKey().references(() => user.id, { onDelete: 'cascade' }),
  id: uuid('id').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const blockedEmailDomain = pgTable('blocked_email_domain', {
  domain: text('domain').primaryKey(),
  enabled: boolean('enabled').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check('blocked_email_domain_normalized', sql`${table.domain} = lower(btrim(${table.domain})) and length(${table.domain}) between 1 and 253`),
]);
