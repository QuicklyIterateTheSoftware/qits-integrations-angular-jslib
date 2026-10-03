import { ErrorHandler, Injectable } from '@angular/core';
import type { Logger, LogRecord, SeverityNumber } from '@opentelemetry/api-logs';

// SeverityNumber.ERROR as a literal: a value import of the enum would put @opentelemetry/api-logs
// (~3 kB) in the consumer's initial bundle, for one number.
const SEVERITY_ERROR = 17 satisfies SeverityNumber.ERROR;

// Set by initQitsIntegration once telemetry is lit; undefined keeps the handler console-only.
let errorLogger: Logger | undefined;

// Records held while initQitsIntegration still loads the config and the SDK; undefined when not
// buffering. Capped, so an error loop during a slow load cannot grow it without bound.
let pending: LogRecord[] | undefined;
const MAX_PENDING = 100;

/** Hold error records until setErrorLogger says whether telemetry is lit. */
export function beginErrorBuffering(): void {
  pending ??= [];
}

/**
 * Ends buffering: with a logger, ships what was held and every later error; without one (dark),
 * drops what was held.
 */
export function setErrorLogger(logger: Logger | undefined): void {
  errorLogger = logger;
  const held = pending ?? [];
  pending = undefined;
  if (logger) {
    held.forEach((record) => logger.emit(record));
  }
}

/**
 * Ships uncaught errors as ERROR-severity OTLP log records (surfacing them in the qits errors feed
 * and telemetryErrors MCP tool), then defers to Angular's default console logging.
 *
 * ErrorHandler is the one funnel that sees everything in a zoneless app: zoneless Angular catches
 * event-handler exceptions before they ever reach window's error event, and
 * provideBrowserGlobalErrorListeners forwards genuinely-global errors and unhandled rejections
 * here too. Errors raised while the SDK still loads are held and shipped once it arrives.
 */
@Injectable()
export class TelemetryErrorHandler extends ErrorHandler {
  override handleError(error: unknown): void {
    if (errorLogger || pending) {
      const record = toLogRecord(error);
      if (errorLogger) {
        errorLogger.emit(record);
      } else if (pending && pending.length < MAX_PENDING) {
        pending.push({ ...record, timestamp: Date.now() }); // when it happened, not when shipped
      }
    }
    super.handleError(error);
  }
}

function toLogRecord(error: unknown): LogRecord {
  const err = error instanceof Error ? error : new Error(String(error));
  return {
    severityNumber: SEVERITY_ERROR,
    severityText: 'ERROR',
    body: err.message,
    attributes: {
      'exception.type': err.name,
      'exception.message': err.message,
      'exception.stacktrace': err.stack ?? '',
    },
  };
}
