"""update_cohort: validates a cohort change and returns the merged filter. Changes nothing itself."""
import logging

from cohort_fields import Ambiguous, Closest, Resolved, resolve_field, resolve_values
from cohort_filter import apply_changes, label
from results import failure, ok, outcome
from virtual_lab_client import ClientError

logger = logging.getLogger(__name__)


def _read_changes(args):
    changes = args.get("changes") if isinstance(args, dict) else None
    if not isinstance(changes, list) or not changes:
        return None
    for change in changes:
        if not isinstance(change, dict) or not isinstance(change.get("field"), str):
            return None
        if change.get("op") not in ("set", "remove"):
            return None
        if change["op"] == "set":
            values = change.get("values")
            if not (isinstance(values, list) and values and all(isinstance(v, str) for v in values)):
                return None
    return changes


def _resolve(changes, client):
    """Returns (resolved changes, None) or (None, a non-ok result)."""
    resolved = []
    for change in changes:
        found = resolve_field(change["field"])
        if isinstance(found, Closest):
            return None, outcome(
                "unknown_field", f"There's no cohort field called '{change['field']}'.",
                closest=found.fields)
        if not found.supported:
            return None, outcome(
                "unsupported_field", f"{found.label} is a number range, which isn't supported yet.",
                field=found.name, label=found.label)
        values = []
        if change["op"] == "set":
            available = client.field_values(found.name)
            match = resolve_values(found.name, change["values"], available)
            if isinstance(match, Ambiguous):
                return None, outcome(
                    "ambiguous", f"'{match.requested}' could mean more than one {found.label} value.",
                    field=found.name, label=found.label, requested=match.requested, options=match.options)
            if not isinstance(match, Resolved):
                return None, outcome(
                    "unknown_value", f"{found.label} has no value like '{match.requested}'.",
                    field=found.name, label=found.label, requested=match.requested,
                    available=[v[0] for v in available])
            values = match.values
        resolved.append({"field": found.name, "label": found.label, "values": values, "op": change["op"]})
    return resolved, None


def update_cohort(args, client):
    changes = _read_changes(args)
    if changes is None:
        return failure("invalid_input", "changes must list a field, an op of set or remove, and values for set.")
    base = args.get("cohortFilter") or None
    try:
        resolved, problem = _resolve(changes, client)
        if problem:
            return problem
        new_filter = apply_changes(base, resolved)
        before = client.case_count(base)
        after = client.case_count(new_filter)
    except ClientError as error:
        logger.error("Virtual Lab call failed at %s", error.step)
        return failure(error.step, str(error))
    except ValueError:
        return failure("unsupported_filter", "The current cohort has a filter that can't be changed here.")
    if after == 0:
        return outcome("would_be_empty", "That change would leave no cases, so the cohort is unchanged.",
                       changes=resolved, caseCount=0)
    return ok(f"The cohort went from {before} to {after} cases.",
              changes=resolved, casesBefore=before, casesAfter=after, filter=new_filter,
              cohort={"label": label(new_filter), "caseCount": after})
