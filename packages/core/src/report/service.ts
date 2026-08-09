import { openReadOnlyDatabase } from '../db/connection.ts';
import { LATEST_SCHEMA_VERSION } from '../db/migrate.ts';
import type { FetchLike } from '../pricing/cache.ts';
import { loadPricing, pricingKey } from '../pricing/service.ts';
import type { NeededModel } from '../pricing/service.ts';
import { computeGroupCost, foldBuckets } from './aggregate.ts';
import { SqliteReportRepository } from './repository.ts';
import type { ReportRequest, ReportSummary } from './types.ts';

export interface ReportDeps {
  readonly fetchFn?: FetchLike;
  readonly cacheDir?: string;
  readonly configPath?: string;
  readonly nowUtc?: number;
}

export async function generateReport(
  request: ReportRequest,
  deps: ReportDeps = {},
): Promise<ReportSummary> {
  const db = openReadOnlyDatabase(request.databasePath, LATEST_SCHEMA_VERSION);
  try {
    const repository = new SqliteReportRepository(db);
    // first pass only discovers which models need prices; pricing may hit
    // the network and must not pin a database snapshot open meanwhile
    const discovered = repository.aggregate(request);

    const neededByKey = new Map<string, NeededModel>();
    for (const row of discovered) {
      neededByKey.set(pricingKey(row.agent, row.provider, row.model), {
        agent: row.agent,
        provider: row.provider,
        model: row.model,
      });
    }
    const pricing = await loadPricing({
      needed: [...neededByKey.values()],
      allowRefresh: !request.noRefresh,
      fetchFn: deps.fetchFn,
      cacheDir: deps.cacheDir,
      configPath: deps.configPath,
      nowUtc: deps.nowUtc,
    });

    // aggregate and per-row tier reads must observe ONE snapshot: without
    // this transaction a concurrent scan could commit between them and
    // the tier repricing would count rows the aggregate never saw
    db.exec('BEGIN');
    let entries;
    try {
      const rows = repository.aggregate(request);
      entries = rows.map((row) => ({
        row,
        cost: computeGroupCost(
          row,
          pricing.resolutions.get(pricingKey(row.agent, row.provider, row.model)) ?? null,
          () => repository.iterateRowsForGroup(request, row),
        ),
      }));
    } finally {
      db.exec('COMMIT');
    }
    const { buckets, totals } = foldBuckets(request.groupBy, entries);

    return {
      command: 'report',
      databasePath: request.databasePath,
      groupBy: request.groupBy,
      agent: request.agent,
      range: request.range,
      buckets,
      totals,
      pricing: {
        status: pricing.status,
        asOfUtc: pricing.asOfUtc,
        sources: pricing.sources,
        warnings: pricing.warnings,
      },
    };
  } finally {
    db.close();
  }
}
