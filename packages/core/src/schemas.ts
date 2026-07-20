import { z } from 'zod';
import type { MigrationPlan, StateFile } from './types.js';

const folderPlanSchema = z.object({
  folderPath: z.string(),
  mode: z.enum(['page_tree', 'database']),
  suggestionReason: z.string().optional(),
});

const frontmatterMappingSchema = z.object({
  key: z.string(),
  notionPropertyType: z.enum(['title', 'rich_text', 'number', 'checkbox', 'date', 'multi_select', 'url']),
});

export const migrationPlanSchema = z.object({
  version: z.literal(1),
  vaultPath: z.string(),
  parentPageId: z.string(),
  folders: z.array(folderPlanSchema),
  frontmatterMappings: z.record(z.string(), z.array(frontmatterMappingSchema)),
  skipList: z.array(z.string()),
}) satisfies z.ZodType<MigrationPlan>;

const noteStateSchema = z.object({
  status: z.enum(['pending', 'created', 'linked', 'attached', 'done', 'failed', 'skipped']),
  pageId: z.string().optional(),
  pageUrl: z.string().optional(),
  contentHash: z.string().optional(),
  error: z.string().optional(),
  attachedPlaceholders: z.array(z.string()).optional(),
});

const fileStateSchema = z.object({
  status: z.enum(['pending', 'uploaded', 'attached', 'failed', 'skipped']),
  fileUploadId: z.string().optional(),
  error: z.string().optional(),
});

const folderStateSchema = z.object({
  status: z.enum(['pending', 'created', 'failed']),
  kind: z.enum(['page', 'database']),
  notionId: z.string(),
  dataSourceId: z.string().optional(),
  error: z.string().optional(),
});

export const stateFileSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  parentPageId: z.string(),
  canonicalVaultPath: z.string().optional(),
  planHash: z.string().optional(),
  notionWorkspaceId: z.string().optional(),
  notionBotId: z.string().optional(),
  signature: z.string().optional(),
  notes: z.record(z.string(), noteStateSchema),
  files: z.record(z.string(), fileStateSchema),
  folders: z.record(z.string(), folderStateSchema).default({}),
}) satisfies z.ZodType<StateFile>;

export function parseMigrationPlan(raw: unknown): MigrationPlan {
  return migrationPlanSchema.parse(raw);
}

export function parseStateFile(raw: unknown): StateFile {
  return stateFileSchema.parse(raw);
}
