export class MissingCurrencyError extends Error {
  readonly code = 'MISSING_CURRENCY';

  constructor(readonly missing: readonly string[]) {
    super(`Exchange rates are missing for: ${missing.join(', ')}`);
    this.name = 'MissingCurrencyError';
  }
}

export class SnapshotAlreadyExistsError extends Error {
  readonly code = 'SNAPSHOT_ALREADY_EXISTS';

  constructor(readonly importId: string) {
    super(`An exchange rate snapshot already exists for import ${importId}`);
    this.name = 'SnapshotAlreadyExistsError';
  }
}
