"""Turns one AG-UI request into wire events. Knows nothing about Bedrock or Gateway."""
import asyncio
import logging
from typing import AsyncIterator, Callable

from ag_ui.core import EventType, RunAgentInput, RunErrorEvent
from pydantic import ValidationError

from cohort import cohort_from_state

logger = logging.getLogger(__name__)

FAILURE_MESSAGE = "The agent could not finish this run."


def _to_wire(event) -> dict:
    return event.model_dump(mode="json", by_alias=True, exclude_none=True)


def _run_error(code: str, message: str) -> dict:
    return _to_wire(RunErrorEvent(type=EventType.RUN_ERROR, code=code, message=message))


class LazyAdapter:
    """Builds the one adapter on the first run. Building it connects to Gateway, so that
    must not happen at import, block health checks, or stay broken after one failure."""

    def __init__(self, factory: Callable):
        self._factory = factory
        self._adapter = None

    async def run(self, run_input, invocation_state=None):
        if self._adapter is None:
            self._adapter = await asyncio.to_thread(self._factory)
        stream = self._adapter.run(run_input, invocation_state=invocation_state)
        try:
            async for event in stream:
                yield event
        finally:
            await stream.aclose()


async def handle_run(payload: dict, adapter, log=logger) -> AsyncIterator[dict]:
    try:
        # This slice has no browser tools, so clients can't add any.
        run_input = RunAgentInput.model_validate(payload).model_copy(update={"tools": []})
    except ValidationError:
        yield _run_error("INVALID_RUN_INPUT", "Request body is not a valid RunAgentInput")
        return

    # The key is always there, even with no cohort: the adapter drops the keys it was
    # given from RAW events, and update_cohort can set this one during the run.
    stream = adapter.run(run_input, invocation_state={"cohort": cohort_from_state(run_input.state)})
    try:
        async for event in stream:
            if event is None:
                continue
            if event.type == EventType.RUN_ERROR:
                # The adapter puts exception text in the message; it stays in the logs.
                log.error("Agent run failed: %s %s", event.code, event.message)
                yield _run_error(event.code or "AGENT_ERROR", FAILURE_MESSAGE)
                continue
            yield _to_wire(event)
    except Exception:
        log.exception("Agent run raised")
        yield _run_error("AGENT_ERROR", FAILURE_MESSAGE)
    finally:
        await stream.aclose()
