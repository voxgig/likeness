
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export type ErrorDef = {
  code: string
  exit: number
  means: string
  partial: boolean
  retryable: boolean
}

function specDir (): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'spec', 'errors.json'))) return join(dir, 'spec')
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  throw new Error(
    'spec/errors.json not found above ' + dirname(fileURLToPath(import.meta.url)) +
    ' - run `make spec-build` from the repository root')
}

const SPEC = specDir()

let registry: Record<string, ErrorDef> | null = null

export function errors (): Record<string, ErrorDef> {
  if (null === registry) {
    const raw = readFileSync(join(SPEC, 'errors.json'), 'utf8')
    registry = JSON.parse(raw).error as Record<string, ErrorDef>
  }
  return registry
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
