import pino from 'pino';
import type { Logger } from '@/core/ports';

/**
 * pino logger adapter. Redacts anything that could carry personal data beyond
 * published business channels; the engine never logs message bodies of replies.
 */
export function createLogger(level = process.env['LOG_LEVEL'] ?? 'info'): Logger {
  const logger = pino({
    level,
    base: { app: 'lead-hunter' },
    redact: {
      paths: ['phone', 'payload.phone', 'evidence', 'body'],
      censor: '[redacted]',
    },
    formatters: { level: (label) => ({ level: label }) },
  });
  return {
    debug: (obj, msg) => logger.debug(obj, msg),
    info: (obj, msg) => logger.info(obj, msg),
    warn: (obj, msg) => logger.warn(obj, msg),
    error: (obj, msg) => logger.error(obj, msg),
  };
}
