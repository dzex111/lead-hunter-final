/**
 * Re-export barrel so repository code imports tables from one stable module.
 * The Drizzle schema itself lives in src/db/schema.ts (platform convention).
 */
export {
  auditLog,
  customerExclusions,
  jobs,
  leadIdentities,
  leads,
  mergeLog,
  modelVersions,
  observations,
  outcomes,
  outreachAttempts,
  recurringSchedules,
  scores,
  searchQueries,
  senderDays,
  senderState,
  suppression,
  templateVariants,
  templates,
} from '@/db/schema';
