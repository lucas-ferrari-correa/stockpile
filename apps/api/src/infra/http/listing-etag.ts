import { createHash } from 'node:crypto';
import { HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';

export interface EtagTarget {
  route: string;
  version: readonly string[];
  query: object;
}

export type EtagOutcome = { kind: 'not-modified' } | { kind: 'fresh'; etag: string };

function normalizedQuery(query: object): Array<[string, unknown]> {
  return Object.entries(query)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

export function listingEtag(target: EtagTarget): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([target.route, target.version, normalizedQuery(target.query)]))
    .digest('base64url');

  return `"${digest}"`;
}

function opaqueTag(entityTag: string): string {
  return entityTag.startsWith('W/') ? entityTag.slice(2) : entityTag;
}

export function ifNoneMatchMatches(header: string | undefined, etag: string): boolean {
  if (header === undefined) {
    return false;
  }

  const current = opaqueTag(etag);
  return header
    .split(',')
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === '*' || opaqueTag(candidate) === current);
}

export function negotiateEtag(request: Request, response: Response, target: EtagTarget): EtagOutcome {
  const etag = listingEtag(target);
  response.setHeader('ETag', etag);
  response.setHeader('Cache-Control', 'private, no-cache');
  response.setHeader('Vary', 'Authorization, X-API-Key');

  if (!ifNoneMatchMatches(request.get('If-None-Match'), etag)) {
    return { kind: 'fresh', etag };
  }

  response.status(HttpStatus.NOT_MODIFIED).end();
  return { kind: 'not-modified' };
}

export const ETAG_RESPONSE_HEADERS = {
  ETag: { description: 'Strong validator of this page', schema: { type: 'string' } },
  'Cache-Control': { description: 'Always "private, no-cache"', schema: { type: 'string' } },
  Vary: { description: 'Always "Authorization, X-API-Key"', schema: { type: 'string' } },
};
