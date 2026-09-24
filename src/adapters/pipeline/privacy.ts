import { eq } from 'drizzle-orm';
import { db as defaultDb } from '@/db';
import {
  auditLog as auditLogTable,
  leadIdentities as leadIdentitiesTable,
  leads as leadsTable,
  observations as observationsTable,
  outcomes as outcomesTable,
  outreachAttempts as attemptsTable,
  scores as scoresTable,
  suppression as suppressionTable,
} from '@/adapters/db/tables';
import type { Db } from '@/adapters/db/repo';

/**
 * Privacy operations (Algerian Law 18-07 § 2: right of access, right to
 * erasure). Only business-public data is stored; these helpers implement the
 * operator-facing commands `export <lead>` and `purge --lead`.
 */

export interface LeadExportBundle {
  exportedAt: string;
  legalNote: string;
  lead: Record<string, unknown> | null;
  identities: Record<string, unknown>[];
  observations: Record<string, unknown>[];
  scores: Record<string, unknown>[];
  attempts: Record<string, unknown>[];
  outcomes: Record<string, unknown>[];
  suppressions: Record<string, unknown>[];
  audit: Record<string, unknown>[];
}

export const LAW_18_07_NOTE =
  'Algerian Law 18-07 (2018) on the protection of natural persons in the processing of personal data: ' +
  'only business-public professional contact data is collected, the operator must honour access/erasure requests, ' +
  'keep data for a defined retention period (LEADHUNTER_RETENTION_DAYS), and never process data for a purpose ' +
  'incompatible with the declared one. Political or sensitive data is out of scope and never collected.';

export async function exportLeadBundle(leadId: string, db: Db = defaultDb): Promise<LeadExportBundle> {
  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId)).limit(1);
  const identities = lead
    ? await db.select().from(leadIdentitiesTable).where(eq(leadIdentitiesTable.leadId, leadId))
    : [];
  const observations = lead
    ? await db.select().from(observationsTable).where(eq(observationsTable.leadId, leadId))
    : [];
  const scoreRows = lead ? await db.select().from(scoresTable).where(eq(scoresTable.leadId, leadId)) : [];
  const attempts = lead ? await db.select().from(attemptsTable).where(eq(attemptsTable.leadId, leadId)) : [];
  const outcomeRows = lead ? await db.select().from(outcomesTable).where(eq(outcomesTable.leadId, leadId)) : [];
  const suppressionRows = lead
    ? await db.select().from(suppressionTable).where(eq(suppressionTable.value, leadId))
    : [];
  const auditRows = lead
    ? await db.select().from(auditLogTable).where(eq(auditLogTable.entityId, leadId)).limit(500)
    : [];

  return {
    exportedAt: new Date().toISOString(),
    legalNote: LAW_18_07_NOTE,
    lead: lead ? { ...lead } : null,
    identities: identities.map((row) => ({ ...row })),
    observations: observations.map((row) => ({ ...row })),
    scores: scoreRows.map((row) => ({ ...row })),
    attempts: attempts.map((row) => ({ ...row })),
    outcomes: outcomeRows.map((row) => ({ ...row })),
    suppressions: suppressionRows.map((row) => ({ ...row })),
    audit: auditRows.map((row) => ({ ...row })),
  };
}

/** Hard delete: erases the lead and every derived row (right to erasure). */
export async function purgeLeadData(leadId: string, db: Db = defaultDb): Promise<void> {
  await db.delete(observationsTable).where(eq(observationsTable.leadId, leadId));
  await db.delete(scoresTable).where(eq(scoresTable.leadId, leadId));
  await db.delete(attemptsTable).where(eq(attemptsTable.leadId, leadId));
  await db.delete(outcomesTable).where(eq(outcomesTable.leadId, leadId));
  await db.delete(leadIdentitiesTable).where(eq(leadIdentitiesTable.leadId, leadId));
  await db.delete(leadsTable).where(eq(leadsTable.id, leadId));
  // The suppression entry is intentionally KEPT: erasure must not resurrect a
  // do-not-contact decision.
}

export function retentionCutoff(days: number, now = new Date()): Date {
  return new Date(now.getTime() - days * 86_400_000);
}
