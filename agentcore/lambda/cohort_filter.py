"""Merges field changes into a cohort filter. Reads and writes the shape
buildCohortGqlOperator gives: {"and": [{"in": {field: [values]}}, ...]}."""
import copy

from cohort_fields import field_label

OPAQUE_FIELD = "case_id"  # Save Cohort builds these. They're kept as they are.


UNSAFE = "The cohort filter has a shape that can't be changed safely."


def _parse(cohort_filter):
    """Split a filter into entries: (field, values, item). `field` is set for an `in` entry,
    and `values` is a list of strings only when the entry is simple. Every other entry
    has field None and is kept as it is. Raises ValueError for a top-level shape that
    can't be edited."""
    if cohort_filter is None:
        return []
    if not isinstance(cohort_filter, dict) or not cohort_filter:
        raise ValueError(UNSAFE)
    if set(cohort_filter) == {"and"}:
        if not isinstance(cohort_filter["and"], list):
            raise ValueError(UNSAFE)
        items = cohort_filter["and"]
    elif len(cohort_filter) == 1 and "or" not in cohort_filter:
        items = [cohort_filter]
    else:
        raise ValueError(UNSAFE)
    entries = []
    for item in items:
        if not isinstance(item, dict):
            raise ValueError(UNSAFE)
        body = item.get("in") if set(item) == {"in"} else None
        if isinstance(body, dict) and len(body) == 1:
            (name, values), = body.items()
            simple = isinstance(values, list) and all(isinstance(v, str) for v in values)
            entries.append((name, list(values) if simple else None, item))
        else:
            entries.append((None, None, item))
    return entries


def _build(entries):
    if not entries:
        return None
    return {"and": [item for _, _, item in entries]}


def apply_changes(base, changes):
    entries = _parse(copy.deepcopy(base))
    for change in changes:
        name, op = change["field"], change["op"]
        if name == OPAQUE_FIELD or op not in ("set", "remove"):
            raise ValueError("That change can't be applied.")
        position = next((i for i, (n, _, _) in enumerate(entries) if n == name), None)
        if position is not None and entries[position][1] is None:
            raise ValueError(UNSAFE)  # The field's own entry isn't a simple list of strings.
        if op == "remove":
            if position is not None:
                del entries[position]
            continue
        entry = (name, list(change["values"]), {"in": {name: list(change["values"])}})
        if position is None:
            entries.append(entry)
        else:
            entries[position] = entry
    return _build(entries)


def simple_fields(cohort_filter):
    return {name: values for name, values, _ in _parse(cohort_filter)
            if name is not None and name != OPAQUE_FIELD and values is not None}


def label(cohort_filter):
    try:
        entries = _parse(cohort_filter)
    except ValueError:
        return "Selected cases"
    if not entries:
        return "All cases"
    parts = []
    if any(name == OPAQUE_FIELD for name, _, _ in entries):
        parts.append("Selected cases")
    parts += [f"{field_label(name)}: {', '.join(values)}" for name, values, _ in entries
              if name is not None and name != OPAQUE_FIELD and values is not None]
    other = any(name is None or (name != OPAQUE_FIELD and values is None) for name, values, _ in entries)
    text = "; ".join(parts)
    if other:
        return f"{text} + other filters" if text else "Other filters"
    return text
