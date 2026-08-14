import { openReadOnlyDatabase } from '../db/connection.ts';
import { LATEST_SCHEMA_VERSION } from '../db/migrate.ts';
import { billingNature, loadBillingOverrides } from '../pricing/billing-nature.ts';
import type { FetchLike } from '../pricing/cache.ts';
import { defaultConfigPath } from '../pricing/config.ts';
import { loadPricing, pricingKey } from '../pricing/service.ts';
import type { NeededModel } from '../pricing/service.ts';
import { computeGroupCost, foldBuckets } from './aggregate.ts';
import {
  MAX_REPORT_GROUPS,
  ReportCardinalityError,
  SqliteReportRepository,
} from './repository.ts';
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
    // refuse pathological cardinality up front (audit D-05): a report
    // with silently truncated totals would be worse than no report
    const groupCount = repository.countGroups(request);
    if (groupCount > MAX_REPORT_GROUPS) {
      throw new ReportCardinalityError(groupCount);
    }
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
    // settlement classification shares the pricing config file; a broken
    // billing section degrades to defaults and surfaces as a warning
    const billing = loadBillingOverrides(deps.configPath ?? defaultConfigPath());

    // aggregate and per-row tier reads must observe ONE snapshot: without
    // this transaction a concurrent scan could commit between them and
    // the tier repricing would count rows the aggregate never saw
    db.exec('BEGIN');
    let entries;
    try {
      // re-check the cap inside the snapshot: rows inserted while
      // pricing was on the network could push past it, and the early
      // check above saw an older database state (audit CX-2)
      const finalCount = repository.countGroups(request);
      if (finalCount > MAX_REPORT_GROUPS) {
        throw new ReportCardinalityError(finalCount);
      }
      const rows = repository.aggregate(request);
      entries = rows.map((row) => ({
        row,
        cost: computeGroupCost(
          row,
          billingNature(row.agent, row.provider, billing.overrides),
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
        warnings: [...pricing.warnings, ...billing.warnings],
      },
    };
  } finally {
    db.close();
  }
}
