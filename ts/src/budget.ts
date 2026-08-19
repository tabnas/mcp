/* Copyright (c) 2026 tabnas, MIT License */

/* budget.ts
 * The hosted endpoint's transport limits and its shape-only telemetry.
 *
 * SEPARATE FROM worker.ts because a modules-format Worker's entry module
 * may only export handlers: workerd type-checks every named export and
 * refuses one that is not a function or an ExportedHandler, so a plain
 * `export const MAX_BODY_BYTES = 262144` on the entry is a startup
 * error —
 *
 *   Incorrect type for map entry 'MAX_BODY_BYTES': the provided value is
 *   not of type 'function or ExportedHandler'.
 *
 * — not a deploy-time one. Constants the tests need therefore live here,
 * one import away from the entry, where they are ordinary module
 * exports again.
 */

import { RATE_LIMIT } from './data-bundle'

// --- budget -----------------------------------------------------------------

// Parsing attacker-controlled text on shared infrastructure means limits are
// correctness, not tuning. The two that the engine itself enforces
// (MAX_GRAMMAR_RULES, MAX_TEST_ROWS) live in core; these are the transport's.
export const MAX_BODY_BYTES = 256 * 1024

// The per-IP request rate, derived from the `ratelimits` binding in
// wrangler.json (embed-data.js reads it). The PLATFORM enforces this;
// the values here exist so the endpoint can state its own ceiling in
// /.well-known/mcp and in the refusal, rather than making a caller
// discover it by being refused.
export { RATE_LIMIT }

// A limit breach answers with a documented, structured diagnostic rather than
// a bare 413: an agent has to be able to correct rather than guess, which
// means it needs the ceiling and which limit it hit.
export function limitExceeded(limit: string, ceiling: number, actual: number) {
  return {
    status: 'failure' as const,
    code: 'limit_exceeded',
    limit,
    ceiling,
    actual,
    message: `request exceeds the ${limit} limit of ${ceiling}`,
    hint:
      `The hosted endpoint bounds ${limit} at ${ceiling}. Run the same tool ` +
      'locally with `npx --yes @tabnas/mcp mcp` for unbounded input — it is ' +
      'the same code with the same answers.',
  }
}

// A refusal that says when to come back. Same reasoning as
// limitExceeded: an agent has to be able to correct rather than guess,
// and the honest correction for a rate limit is either "wait" or "run it
// locally, where there is no limit at all".
export function rateLimited() {
  return {
    status: 'failure' as const,
    code: 'rate_limited',
    limit: 'requests per IP',
    ceiling: RATE_LIMIT.limit,
    period_seconds: RATE_LIMIT.period,
    message: `rate limit exceeded: ${RATE_LIMIT.limit} requests per ` +
      `${RATE_LIMIT.period}s per IP`,
    hint:
      `The hosted endpoint allows ${RATE_LIMIT.limit} requests per ` +
      `${RATE_LIMIT.period} seconds per IP. Retry after ` +
      `${RATE_LIMIT.period}s, or run the same tool locally with ` +
      '`npx --yes @tabnas/mcp mcp` for no limit at all — it is the same ' +
      'code with the same answers.',
  }
}

// --- telemetry --------------------------------------------------------------

export type Telemetry = {
  tool: string
  bytes_bucket: string
  duration_ms: number
  status: 'ok' | 'error'
  code?: string
}

// Size as a BUCKET, never a length: an exact byte count of a document is a
// weak fingerprint of the document, and this service promises not to hold
// facts about content.
export function bucket(bytes: number): string {
  if (bytes <= 1024) return '<=1k'
  if (bytes <= 16 * 1024) return '<=16k'
  if (bytes <= 64 * 1024) return '<=64k'
  return '<=256k'
}

// Overridable so tests can observe what would be emitted, and so a deploy can
// wire a sink without this file knowing about one.
export let emit: (t: Telemetry) => void = () => {}
export function setTelemetrySink(sink: (t: Telemetry) => void): void {
  emit = sink
}
