
import type { Station } from '@voxgig/station'

import type { Note } from './note.js'
import * as joplin from './adapter/joplin.js'
import * as notion from './adapter/notion.js'
import * as obsidian from './adapter/obsidian.js'

export type Conn = {
  instance: string
  account: string
}

export type Check = {
  ok: boolean
  code?: string
  detail: string
  remedy?: string
}

/* `sources add`'s base and the flags the source reads, each its declared
 * default when none was given. */
export type Given = Record<string, unknown>

export type Ask = {
  tty: boolean
  confirm: (label: string) => Promise<boolean>
  // The fingerprint of the certificate an https base presents.
  presented: (base: string) => Promise<string>
}

/* What every source's adapter offers the core. The handle `connect` returns is
 * the adapter's own; the core passes it back and never looks inside it. */
export type Adapter = {
  SOURCE: string
  SUPPLIES: string[]
  configure?: (instance: string, block: Record<string, unknown>) => unknown
  connect: (station: Station, conn: Conn, config: unknown, seed?: unknown) => unknown
  listNotes?: (handle: any, conn: Conn, withRaw: boolean) => Promise<{ notes: Note[], more: boolean }>
  loadNote?: (handle: any, conn: Conn, id: string, withRaw: boolean) => Promise<Note | null>
  check: (handle: any) => Promise<Check>
  // The block `sources add` writes; with none, the block is the base alone.
  setup?: (instance: string, given: Given, ask: Ask) => Promise<Record<string, unknown>>
  // The account a connection reaches, where the capability data says it can be asked.
  account?: (handle: any) => Promise<string>
}

const ALL: Adapter[] = [joplin, notion, obsidian]

export const ADAPTERS: Record<string, Adapter> =
  Object.fromEntries(ALL.map(a => [a.SOURCE, a]))
