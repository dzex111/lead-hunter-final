/**
 * Small repository helpers that sit on top of repo.ts but would make it noisy
 * if inlined. Kept in one place so the privacy/CLI surfaces import a single
 * module.
 */
export {
  addSuppression,
  ensureTemplates as ensureTemplatesFromCatalog,
  hardDeleteLead,
  insertObservation,
  listSuppression as suppressionsForExport,
  purgeOldData,
  recordAudit,
} from '@/adapters/db/repo';
export type { Db } from '@/adapters/db/repo';

import { exportLeadBundle, purgeLeadData } from '@/adapters/pipeline/privacy';
export { exportLeadBundle as exportLeads, purgeLeadData as purgeLeadData };
