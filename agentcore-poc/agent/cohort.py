"""Keeps the cohort filter away from the model. A filter can hold case IDs.

The run's cohort lives in invocation_state, which is per run and never reaches the model.
Hooks add the filter to a copy of each tool call and take it out of each tool result.
The browser gets the new cohort through STATE_SNAPSHOT."""
import json
import threading
from collections import OrderedDict

from strands.hooks import AfterToolCallEvent, BeforeToolCallEvent, HookProvider, HookRegistry

UPDATE_TOOL = "virtual-lab___update_cohort"
FILTER_INPUT = "cohortFilter"
FILTER_RESULT = "filter"
LABEL_LIMIT = 200
HIDDEN_LABEL = "Selected cases"

# Hands a new cohort from the After hook, which has invocation_state, to state_from_update,
# which doesn't. A disconnected client can leave an entry unread, so the map has a limit.
PENDING_LIMIT = 256
_pending = OrderedDict()
_pending_lock = threading.Lock()


def _remember(tool_use_id, cohort):
    with _pending_lock:
        _pending[tool_use_id] = cohort
        while len(_pending) > PENDING_LIMIT:
            _pending.popitem(last=False)


def pending_count():
    with _pending_lock:
        return len(_pending)


def _has_case_ids(text):
    return "SYNTH-" in text.upper()


def cohort_from_state(state):
    """The cohort sent by the browser, or None. A null filter is a cohort with no filters;
    a cohort without the key isn't one, so nothing claims a cohort that isn't applied."""
    cohort = state.get("cohort") if isinstance(state, dict) else None
    return dict(cohort) if isinstance(cohort, dict) and FILTER_RESULT in cohort else None


def _revision(cohort):
    revision = cohort.get("revision") if cohort else None
    return revision if type(revision) is int else 0


def _without_filters(value):
    if isinstance(value, dict):
        return {key: _without_filters(item) for key, item in value.items() if key != FILTER_RESULT}
    if isinstance(value, list):
        return [_without_filters(item) for item in value]
    return value


def _clean_body(body, revision):
    clean = {key: value for key, value in body.items() if key != FILTER_RESULT}
    if isinstance(clean.get("cohort"), dict):
        shown = {**clean["cohort"], "revision": revision}
        if isinstance(shown.get("label"), str) and _has_case_ids(shown["label"]):
            shown["label"] = HIDDEN_LABEL
        clean["cohort"] = shown
    return clean


def _text_body(block):
    """The JSON object in a text block, or None if it doesn't hold one."""
    try:
        body = json.loads(block["text"])
    except (KeyError, TypeError, ValueError):
        return None
    return body if isinstance(body, dict) else None


def _first_body(result):
    for block in result.get("content") or []:
        body = _text_body(block) if isinstance(block, dict) else None
        if body is not None:
            return body
    structured = result.get("structuredContent")
    return structured if isinstance(structured, dict) else None


def _is_cohort_change(result, body):
    return (result.get("status") != "error" and body is not None and body.get("status") == "ok"
            and FILTER_RESULT in body and isinstance(body.get("cohort"), dict))


def _clean_result(result, revision):
    """A copy of the tool result for the model. Text that isn't a JSON object stays as it is."""
    content = []
    for block in result.get("content") or []:
        body = _text_body(block) if isinstance(block, dict) else None
        if body is not None:
            block = {**block, "text": json.dumps(_clean_body(body, revision))}
        content.append(block)
    clean = {**result, "content": content}
    if "structuredContent" in clean:
        structured = _without_filters(clean["structuredContent"])
        clean["structuredContent"] = _clean_body(structured, revision) if isinstance(structured, dict) else structured
    return clean


class CohortHooks(HookProvider):
    """Holds nothing itself: one instance serves every thread in the process."""

    def register_hooks(self, registry: HookRegistry, **kwargs):
        registry.add_callback(BeforeToolCallEvent, self.before)
        registry.add_callback(AfterToolCallEvent, self.after)

    def before(self, event):
        tool_use = event.tool_use
        arguments = dict(tool_use["input"]) if isinstance(tool_use.get("input"), dict) else {}
        arguments.pop(FILTER_INPUT, None)  # A filter the model made up is never used.
        cohort = event.invocation_state.get("cohort")
        if cohort is not None:
            arguments[FILTER_INPUT] = cohort.get(FILTER_RESULT)
        # A copy: the model's own tool_use is what stays in the message history.
        event.tool_use = {**tool_use, "input": arguments}

    def after(self, event):
        result = event.result
        body = _first_body(result)
        revision = _revision(event.invocation_state.get("cohort"))
        changed = event.tool_use["name"] == UPDATE_TOOL and _is_cohort_change(result, body)
        if changed:
            revision += 1
        event.result = _clean_result(result, revision)
        if changed:
            shown = _clean_body(body, revision)["cohort"]
            cohort = {"filter": body[FILTER_RESULT], "label": shown.get("label"), "caseCount": shown.get("caseCount"),
                      "revision": revision, "changes": body.get("changes")}
            event.invocation_state["cohort"] = cohort
            _remember(event.tool_use["toolUseId"], cohort)


def state_from_update(ctx):
    """The whole cohort for STATE_SNAPSHOT, which carries only what's returned here."""
    with _pending_lock:
        cohort = _pending.pop(ctx.tool_use_id, None)
    return {"cohort": cohort} if cohort is not None else None


def _safe_label(cohort):
    label = cohort.get("label")
    if not isinstance(label, str) or _has_case_ids(label):
        return None
    return " ".join(label.split())[:LABEL_LIMIT] or None


def prompt_context(run_input, message):
    """The researcher's message plus what the model may know about the cohort: its label,
    its case count and the manual-change flag. The label comes from the browser, so it's checked."""
    cohort = cohort_from_state(run_input.state)
    if cohort is None:
        return message
    label = _safe_label(cohort)
    count = cohort.get("caseCount")
    facts = [f"Selected cohort: {label}." if label else "Selected cohort: no name available."]
    if type(count) is int:
        facts.append(f"Cases: {count}.")
    if cohort.get("changedOutsideChat") is True:
        facts.append('The researcher changed the cohort outside chat, so start your answer with "Now using: ", '
                     "then this cohort's name and case count.")
    return f"{message}\n\n[{' '.join(facts)}]"
