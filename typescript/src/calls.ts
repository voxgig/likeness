
import type { Station } from '@voxgig/station'

export type Call = {
  instance: string
  method: string
  path: string
}

// The requests a run made, as station observed them at the transport, one per
// attempt. Tapped rather than read back, because the event ring drops its oldest.
export class Calls {
  private list: Call[] = []

  constructor (station: Station | null) {
    station?.tap((e) => {
      if ('http' === e.kind && undefined !== e.http) {
        this.list.push({ instance: String(e.plugin), method: e.http.method, path: e.http.path })
      }
    })
  }

  all (): Call[] { return this.list.slice() }
  count (): number { return this.list.length }
}
