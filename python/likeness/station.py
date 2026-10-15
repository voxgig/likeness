"""Station over the configuration: the active profile, and the instances it declares."""

from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from likeness.errors import LikenessError

if TYPE_CHECKING:
    from voxgig_station import Station


@dataclass(frozen=True)
class Connection:
    instance: str
    source: str
    account: str


def profile_of(env: dict[str, str] | None = None) -> str:
    return (env or {}).get('VOXGIG_STATION_PROFILE') or 'default'


def open_station(config: Any, env: dict[str, str] | None = None) -> Station:
    # Imported on first use, like each adapter's SDK: `version` and `help`
    # need neither, and loading them is most of a cold start.
    from voxgig_station import Station
    return Station({
        'config': config,
        'profile': profile_of(env),
        'proxy': 'off',
        'load': False,
    })


def with_chain(config: Any, chain: list[Any]) -> Any:
    """station.json with its secret chain replaced, in every profile, by the one likeness decided on."""
    if not isinstance(config, (dict, list)):
        return config
    out = copy.deepcopy(config)
    profiles = out.get('profiles') if isinstance(out, dict) else None
    members = profiles.values() if isinstance(profiles, dict) else profiles if isinstance(profiles, list) else []
    for p in members:
        if isinstance(p, dict):
            p['secrets'] = {'providers': chain}
    return out


def connections_of(station: Station, accounts: dict[str, str], profile: str) -> list[Connection]:
    """Every active declared instance, in station's ref order. An instance with
    no account under the profile is refused: identity may not be derived from the ref."""
    out = []
    for i in station.instances():
        if not i['active']:
            continue
        account = accounts.get(i['name'])
        if not isinstance(account, str) or '' == account:
            raise LikenessError(
                'invalid-project',
                'instance "' + i['name'] + '" has no account in likeness.json under profile "' + profile + '"',
                'add `"' + i['name'] + '": { "account": "<id>" }` under `profiles.' + profile +
                '.instances` in likeness.json')
        out.append(Connection(i['name'], i['api'], account))
    return out
