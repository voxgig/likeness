
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

type Caps = Record<string, {
  name: string
  limit: { page_max: number, rate: number, search: string, body: string, version_token: boolean }
  entity: Record<string, { kind: string, sdk: string, term: string, op: Record<string, unknown> }>
}>

function specDir (): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'spec', 'caps.json'))) return join(dir, 'spec')
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  throw new Error('spec/caps.json not found - run `make spec-build` from the repository root')
}

let matrix: Caps | null = null

export function caps (): Caps {
  if (null === matrix) {
    matrix = JSON.parse(readFileSync(join(specDir(), 'caps.json'), 'utf8')).capability as Caps
  }
  return matrix
}

/* The largest page a source will return. Zero means "not declared", which the
 * caller must treat as "cannot tell", never as "no limit".
 */
export function pageMax (source: string): number {
  const c = caps()[source]
  return undefined === c ? 0 : (c.limit?.page_max ?? 0)
}
