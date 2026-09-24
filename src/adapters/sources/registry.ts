import { csvImportSource, manualAddSource, manualPasteSource, socialPasteSource, adLibraryManualSource, directoryImportSource } from '@/adapters/sources/manual';
import { demoSource } from '@/adapters/sources/demo';
import { googlePlacesSource } from '@/adapters/sources/google-places';
import { metaAdLibrarySource } from '@/adapters/sources/meta-ad-library';
import { crawlExpansionSource } from '@/adapters/sources/site-crawl';
import { webSearchSource } from '@/adapters/sources/web-search';
import { SourceNotReadyError, type DiscoverySource } from '@/adapters/sources/types';
import { readFileSync } from 'node:fs';
import type { AppConfig } from '@/config';

/**
 * Registered discovery adapters. `getSource` is the only lookup path used by
 * the CLI/worker, so capability and readiness declarations are always honoured.
 */
export function buildRegistry(config: AppConfig): Map<string, DiscoverySource> {
  const registry = new Map<string, DiscoverySource>();
  const register = (source: DiscoverySource): void => {
    registry.set(source.id, source);
  };
  register(manualPasteSource());
  register(manualAddSource());
  register(socialPasteSource());
  register(csvImportSource((path) => readFileSync(path, 'utf8')));
  register(adLibraryManualSource());
  register(directoryImportSource());
  register(webSearchSource());
  register(googlePlacesSource());
  register(metaAdLibrarySource());
  register(crawlExpansionSource());
  register(demoSource(config));
  return registry;
}

export function getSource(registry: Map<string, DiscoverySource>, id: string): DiscoverySource {
  const source = registry.get(id);
  if (!source) {
    throw new SourceNotReadyError(id, `unknown source. Available: ${[...registry.keys()].join(', ')}`);
  }
  return source;
}

export function describeSources(registry: Map<string, DiscoverySource>, config: AppConfig): string {
  const lines: string[] = [];
  for (const source of registry.values()) {
    const flagNote =
      source.id === 'meta_ad_library_api'
        ? config.flags.metaAdLibraryApi
          ? 'ENABLED (opt-in)'
          : 'FLAGGED OFF (unverified commercial scope for DZ)'
        : source.id === 'demo_seed'
          ? config.flags.demoSource
            ? 'enabled (non-production or opt-in)'
            : 'disabled in production'
          : 'enabled';
    lines.push(
      `${source.id.padEnd(24)} ${source.capabilities.network ? 'net' : 'off'} cost=${source.capabilities.costUnitsPerCall} :: ${flagNote} :: ${source.capabilities.note}`,
    );
  }
  return lines.join('\n');
}
