"""The run-time specification, embedded as package data by `make spec-build`."""

from __future__ import annotations

import json
from functools import cache
from importlib.resources import files
from typing import Any


@cache
def load(name: str) -> Any:
    return json.loads(files(__name__).joinpath(name + '.json').read_text(encoding='utf-8'))
