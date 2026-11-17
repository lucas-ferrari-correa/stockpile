import { InventoryCsvColumn, InventoryRejectionCode, InventoryRow, RejectedByReason } from '@stockpile/shared';

export interface StagedInventoryRow {
  line: number;
  row: InventoryRow;
}

export interface ImportRowRejection {
  line: number;
  field: InventoryCsvColumn | null;
  code: InventoryRejectionCode;
  message: string;
  raw: string;
}

export interface ImportProgress {
  processedRows: number;
  acceptedRows: number;
  rejectedRows: number;
}

export interface ImportStagingBatch {
  rows: readonly StagedInventoryRow[];
  rejections: readonly ImportRowRejection[];
  progress: ImportProgress;
}

export interface ImportRunSummary {
  totalRows: number;
  acceptedRows: number;
  rejectedRows: number;
  rejectedByReason: RejectedByReason;
}

export interface CatalogMergeResult {
  itemsCreated: number;
  itemsUpdated: number;
}

export interface ImportCatalogRepository {
  startRun(importId: string): Promise<boolean>;
  stageBatch(importId: string, batch: ImportStagingBatch): Promise<void>;
  mergeIntoCatalog(importId: string, summary: ImportRunSummary): Promise<CatalogMergeResult>;
  clearStaging(importId: string): Promise<void>;
  analyzeCatalog(): Promise<void>;
}

export const IMPORT_CATALOG_REPOSITORY = Symbol('IMPORT_CATALOG_REPOSITORY');

export class ImportNotProcessingError extends Error {
  readonly code = 'IMPORT_NOT_PROCESSING';

  constructor(readonly importId: string) {
    super(`Import ${importId} is not processing and cannot be merged into the catalog`);
    this.name = 'ImportNotProcessingError';
  }
}
