import { Station } from '@voxgig/station'

import { LikenessError } from './errors.js'

export type Connection = {
  instance: string
  source: string
  account: string
}

export function profileOf (env?: Record<string, string>): string {
  return env?.VOXGIG_STATION_PROFILE || 'default'
}

export function openStation (config: unknown, env?: Record<string, string>): Station {
  return new Station({
    config: (config ?? null) as any,
    profile: profileOf(env),
    proxy: 'off',
    load: false,
  })
}

// station.json with its secret chain replaced, in every profile, by the one
// likeness decided on.
export function withChain (config: unknown, chain: unknown[]): unknown {
  if (null === config || 'object' !== typeof config) return config
  const copy = JSON.parse(JSON.stringify(config))
  for (const p of Object.values(copy.profiles ?? {})) {
    if (null !== p && 'object' === typeof p) (p as Record<string, unknown>).secrets = { providers: chain }
  }
  return copy
}

// Every declared instance, in station's name order, with the account its
// notes' identity derives from. An instance with no account is refused:
// identity may not be derived from the instance name.
export function connectionsOf (station: Station, accounts: Record<string, string>, profile: string): Connection[] {
  return station.instances().filter(i => i.active).map(i => {
    const account = accounts[i.name]
    if ('string' !== typeof account || '' === account) {
      throw new LikenessError('invalid-project',
        'instance "' + i.name + '" has no account in likeness.json under profile "' + profile + '"',
        'add `"' + i.name + '": { "account": "<id>" }` under `profiles.' + profile + '.instances` in likeness.json')
    }
    return { instance: i.name, source: i.api, account }
  })
}
