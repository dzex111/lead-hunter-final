import { createHash } from 'node:crypto';

export function contentHashOf(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

export function shortHash(body: string): string {
  return contentHashOf(body).slice(0, 16);
}
