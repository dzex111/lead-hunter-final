import { NextResponse } from 'next/server';
import { buildCliDeps } from '@/cli/index';
import {
  countLeadsByState,
  searchQueryRows,
  senderSnapshot,
} from '@/adapters/pipeline/index';
import { loadFunnel } from '@/adapters/pipeline/funnel';
import { loadActiveModel } from '@/adapters/pipeline/model';
import { listModelVersions, listSuppression } from '@/adapters/db/repo';

export const dynamic = 'force-dynamic';

/** Machine-readable state of the engine (used by the console and by scripts). */
export async function GET() {
  const deps = buildCliDeps();
  try {
    const [states, funnel, model, sender, queries, suppression, models] = await Promise.all([
      countLeadsByState(deps),
      loadFunnel(deps.db),
      loadActiveModel(deps.clock, deps.db),
      senderSnapshot(deps),
      searchQueryRows(deps),
      listSuppression(20, deps.db),
      listModelVersions(deps.db),
    ]);
    return NextResponse.json({
      states,
      funnel: funnel.stages,
      model: {
        version: model.version,
        nObservations: model.nObservations,
        metrics: model.metrics,
        coldStart: model.coldStart,
        calibrated: model.calibrated,
      },
      sender: { ...sender, state: undefined },
      queries: queries.slice(0, 25),
      suppressionCount: suppression.length,
      modelVersions: models.slice(0, 10),
      flags: {
        serper: deps.config.flags.serper,
        metaAdLibraryApi: deps.config.flags.metaAdLibraryApi,
        llmCategoryFallback: deps.config.flags.llmCategoryFallback,
        saveHtmlSnapshots: deps.config.flags.saveHtmlSnapshots,
        demoSource: deps.config.flags.demoSource,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
