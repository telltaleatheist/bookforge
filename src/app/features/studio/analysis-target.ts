import type { StudioItem } from './models/studio.types';

export type StudioAnalysisTarget =
  | {
      kind: 'document';
      projectId: string;
      versionId: string;
      versionType: string;
      versionLabel: string;
      path: string;
    }
  | {
      kind: 'audiobook';
      projectId: string;
      variantId: string;
      versionLabel: string;
    };

/**
 * StudioItem.id is intentionally inconsistent across the existing Studio data
 * model: articles carry the manifest projectId, while books carry the absolute
 * project directory. Analysis IPC and queue payloads always require the manifest
 * projectId, so every analysis entry point must normalize through this helper.
 */
export function studioManifestProjectId(item: Pick<StudioItem, 'id' | 'type' | 'bfpPath'>): string {
  const identity = item.type === 'book' ? (item.bfpPath || item.id) : item.id;
  return identity.split(/[\\/]/).filter(Boolean).pop() || '';
}
