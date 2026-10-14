
// Embedded at build time: the copy under src/spec/ is written by
// `make spec-build`, so an installed port needs no checkout.
import errorsDoc from './spec/errors.json' with { type: 'json' }

export type ErrorDef = {
  code: string
  exit: number
  means: string
  partial: boolean
  retryable: boolean
}

export function errors (): Record<string, ErrorDef> {
  return errorsDoc.error as Record<string, ErrorDef>
}

export function exitFor (code: string): number {
  const def = errors()[code]
  if (undefined === def) {
    throw new Error('no such error code: ' + code)
  }
  return def.exit
}

/* The closed set of codes permitted to carry data on failure. A caller that
 * branches on `ok` alone stays correct; it just discards results it could have
 * kept. `describe` publishes this so nobody has to guess.
 */
export function partialCodes (): string[] {
  return Object.values(errors()).filter(e => e.partial).map(e => e.code).sort()
}

export class LikenessError extends Error {
  code: string
  remedy: string
  detail: Record<string, string>
  constructor (code: string, message: string, remedy: string, detail: Record<string, string> = {}) {
    super(message)
    this.name = 'LikenessError'
    this.code = code
    this.remedy = remedy
    this.detail = detail
  }
}
