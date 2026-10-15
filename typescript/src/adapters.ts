
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
}

const ALL: Adapter[] = [joplin, notion, obsidian]

export const ADAPTERS: Record<string, Adapter> =
  Object.fromEntries(ALL.map(a => [a.SOURCE, a]))
