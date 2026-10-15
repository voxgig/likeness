
// Embedded at build time, like errors.json.
import capsDoc from './spec/caps.json' with { type: 'json' }

export type Connect = {
  default: Record<string, string>
  flag: string[]
  account: { term: string, discover: boolean, why?: string }
}

type Caps = Record<string, {
  name: string
  limit: { page_max: number, rate: number, search: string, body: string, version_token: boolean }
  entity: Record<string, { kind: string, sdk: string, term: string, op: Record<string, unknown> }>
  connect: Connect
}>

export function caps (): Caps {
  return capsDoc.capability as Caps
}

/* The largest page a source will return. Zero means "not declared", which the
 * caller must treat as "cannot tell", never as "no limit".
 */
export function pageMax (source: string): number {
  const c = caps()[source]
  return undefined === c ? 0 : (c.limit?.page_max ?? 0)
}

// A capability is `false` or absent when refused, and anything else when offered.
export function supports (source: string, entity: string, op: string): boolean {
  const v = caps()[source]?.entity?.[entity]?.op?.[op]
  return undefined !== v && false !== v
}

// The source's own word for one of likeness's entities, or the entity's name.
export function termOf (source: string, entity: string): string {
  return caps()[source]?.entity?.[entity]?.term ?? entity
}

// How `sources add` connects a source, or undefined for one not registered.
export function connectOf (source: string): Connect | undefined {
  return Object.hasOwn(caps(), source) ? caps()[source].connect : undefined
}

// The flags of `sources add` that some source alone reads, in code-point order.
export function sourceFlags (): string[] {
  return [...new Set(Object.values(caps()).flatMap(c => c.connect.flag))].sort()
}
