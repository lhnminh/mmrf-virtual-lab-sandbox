"""Matches what a researcher said to Cohort Builder fields and to values in the data."""
import difflib
import json
import pathlib
from dataclasses import dataclass, field

_CATALOG = json.loads((pathlib.Path(__file__).with_name("cohort_fields.json")).read_text())
FIELDS = _CATALOG["fields"]
_SYNONYMS = _CATALOG["synonyms"]
_VALUE_SYNONYMS = _CATALOG["valueSynonyms"]


@dataclass
class Field:
    name: str
    label: str
    supported: bool


@dataclass
class Closest:
    fields: list = field(default_factory=list)  # [{"field", "label"}]


@dataclass
class Resolved:
    values: list


@dataclass
class Ambiguous:
    requested: str
    options: list


@dataclass
class Unknown:
    requested: str


def _key(text):
    return " ".join(str(text).lower().replace("_", " ").replace(".", " ").split())


def field_label(name):
    entry = FIELDS.get(name)
    return entry["label"] if entry else name.split(".")[-1].replace("_", " ").title()


def _names_for(name):
    """Everything a researcher might call this field."""
    return {_key(name), _key(FIELDS[name]["label"]), _key(name.split(".")[-1])}


def resolve_field(text):
    wanted = _key(text)
    if wanted in {_key(k) for k in _SYNONYMS}:
        name = next(v for k, v in _SYNONYMS.items() if _key(k) == wanted)
        return Field(name, field_label(name), FIELDS[name]["supported"])
    exact = [n for n in FIELDS if wanted in _names_for(n)]
    if len(exact) == 1:
        return Field(exact[0], field_label(exact[0]), FIELDS[exact[0]]["supported"])
    spellings = {}
    for name in FIELDS:
        if FIELDS[name]["supported"]:
            for spelling in _names_for(name):
                spellings.setdefault(spelling, name)
    for spelling in _SYNONYMS:
        spellings.setdefault(_key(spelling), _SYNONYMS[spelling])
    closest = []
    for spelling in difflib.get_close_matches(wanted, list(spellings), n=10, cutoff=0.5):
        name = spellings[spelling]
        if name not in [c["field"] for c in closest]:
            closest.append({"field": name, "label": field_label(name)})
    substring = [spellings[s] for s in spellings if wanted and (wanted in s or s in wanted)]
    for name in substring:
        if name not in [c["field"] for c in closest]:
            closest.append({"field": name, "label": field_label(name)})
    return Closest(closest[:5])


def resolve_values(field_name, requested, available):
    """Case-insensitive exact, then synonyms, then a unique substring. `available` holds
    (value, count) pairs or plain values."""
    present = [v[0] if isinstance(v, (tuple, list)) else v for v in available]
    by_lower = {v.lower(): v for v in present}
    resolved = []
    for text in requested:
        wanted = str(text).strip().lower()
        wanted = _VALUE_SYNONYMS.get(wanted, wanted)
        if wanted in by_lower:
            match = by_lower[wanted]
        else:
            partial = [v for low, v in by_lower.items() if wanted and (wanted in low)]
            if len(partial) > 1:
                return Ambiguous(str(text), partial)
            if not partial:
                return Unknown(str(text))
            match = partial[0]
        if match not in resolved:
            resolved.append(match)
    return Resolved(resolved)
