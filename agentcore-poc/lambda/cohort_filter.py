"""Merges field changes into a cohort filter. Reads and writes the shape
buildCohortGqlOperator gives: {"and": [{"in": {field: [values]}}, ...]}."""
import copy

from cohort_fields import field_label

OPAQUE_FIELD = "case_id"  # Save Cohort builds these. They're kept as they are.


def _entries(cohort_filter):
    """Split a filter into its `in` entries, in order. Raises ValueError for anything else."""
    if cohort_filter is None:
        return []
    if not isinstance(cohort_filter, dict):
        raise ValueError("The cohort filter isn't an object.")
    if set(cohort_filter) == {"in"}:
        items = [cohort_filter]
    elif set(cohort_filter) == {"and"} and isinstance(cohort_filter["and"], list):
        items = cohort_filter["and"]
    else:
        raise ValueError("The cohort filter has a shape that can't be changed safely.")
    entries = []
    for item in items:
        body = item.get("in") if isinstance(item, dict) and set(item) == {"in"} else None
        if not (isinstance(body, dict) and len(body) == 1):
            raise ValueError("The cohort filter has a shape that can't be changed safely.")
        (name, values), = body.items()
        if not (isinstance(values, list) and all(isinstance(v, str) for v in values)):
            raise ValueError("The cohort filter has a shape that can't be changed safely.")
        entries.append((name, list(values)))
    return entries


def _build(entries):
    if not entries:
        return None
    return {"and": [{"in": {name: list(values)}} for name, values in entries]}


def apply_changes(base, changes):
    entries = _entries(copy.deepcopy(base))
    for change in changes:
        name, op = change["field"], change["op"]
        if name == OPAQUE_FIELD or op not in ("set", "remove"):
            raise ValueError("That change can't be applied.")
        position = next((i for i, (n, _) in enumerate(entries) if n == name), None)
        if op == "remove":
            if position is not None:
                del entries[position]
        elif position is None:
            entries.append((name, list(change["values"])))
        else:
            entries[position] = (name, list(change["values"]))
    return _build(entries)


def simple_fields(cohort_filter):
    return {name: values for name, values in _entries(cohort_filter) if name != OPAQUE_FIELD}


def label(cohort_filter):
    entries = _entries(cohort_filter)
    if not entries:
        return "All cases"
    parts = []
    if any(name == OPAQUE_FIELD for name, _ in entries):
        parts.append("Selected cases")
    parts += [f"{field_label(name)}: {', '.join(values)}"
              for name, values in entries if name != OPAQUE_FIELD]
    return "; ".join(parts)
