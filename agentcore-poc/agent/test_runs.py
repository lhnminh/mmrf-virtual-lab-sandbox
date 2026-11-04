"""Run loop tests with a fake adapter. No AWS, no model."""
import asyncio
import logging
import os
import subprocess
import sys
import unittest

from ag_ui.core import EventType, RunErrorEvent, TextMessageContentEvent

from runs import FAILURE_MESSAGE, LazyAdapter, handle_run

VALID = {
    "threadId": "t", "runId": "r", "state": {}, "messages": [], "tools": [],
    "context": [], "forwardedProps": {},
}


class FakeAdapter:
    def __init__(self, events=(), error=None):
        self.events, self.error = events, error
        self.seen, self.closed, self.invocation_state = None, False, None

    def run(self, run_input, invocation_state=None):
        self.seen, self.invocation_state = run_input, invocation_state
        return self._stream()

    async def _stream(self):
        try:
            for event in self.events:
                yield event
            if self.error:
                raise self.error
        finally:
            self.closed = True


def collect(payload, adapter):
    async def go():
        return [event async for event in handle_run(payload, adapter)]
    return asyncio.run(go())


def text_event(delta="hello"):
    return TextMessageContentEvent(type=EventType.TEXT_MESSAGE_CONTENT, message_id="m", delta=delta)


class HandleRun(unittest.TestCase):
    def test_invalid_body(self):
        adapter = FakeAdapter()
        events = collect({}, adapter)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["type"], "RUN_ERROR")
        self.assertEqual(events[0]["code"], "INVALID_RUN_INPUT")
        self.assertIsNone(adapter.seen)

    def test_client_tools_are_cleared(self):
        adapter = FakeAdapter()
        payload = {**VALID, "tools": [{"name": "x", "description": "d", "parameters": {}}]}
        collect(payload, adapter)
        self.assertEqual(adapter.seen.tools, [])

    def test_state_cohort_goes_to_invocation_state(self):
        adapter = FakeAdapter()
        cohort = {"filter": {"in": {"race": ["x"]}}, "label": "L", "caseCount": 1, "revision": 3}
        collect({**VALID, "state": {"cohort": cohort}}, adapter)
        self.assertEqual(adapter.invocation_state, {"cohort": cohort})

    def test_no_cohort_still_sets_the_key(self):
        for state in ({}, None, "text"):
            with self.subTest(state=state):
                adapter = FakeAdapter()
                collect({**VALID, "state": state}, adapter)
                self.assertEqual(adapter.invocation_state, {"cohort": None})

    def test_events_use_wire_names(self):
        event = collect(VALID, FakeAdapter([text_event()]))[0]
        self.assertEqual(event["messageId"], "m")
        self.assertEqual(event["type"], "TEXT_MESSAGE_CONTENT")
        self.assertNotIn("message_id", event)
        self.assertNotIn(None, event.values())

    def test_skips_empty_events(self):
        self.assertEqual(len(collect(VALID, FakeAdapter([None, text_event()]))), 1)

    def test_closes_on_disconnect(self):
        adapter = FakeAdapter([text_event("one"), text_event("two")])

        async def go():
            stream = handle_run(VALID, adapter)
            await stream.__anext__()
            await stream.aclose()
        asyncio.run(go())
        self.assertTrue(adapter.closed)

    def test_closes_on_finish(self):
        adapter = FakeAdapter([text_event()])
        collect(VALID, adapter)
        self.assertTrue(adapter.closed)

    def test_adapter_error_is_sanitized(self):
        error = RunErrorEvent(type=EventType.RUN_ERROR, code="STRANDS_ERROR", message="arn:secret")
        with self.assertLogs("runs", level=logging.ERROR) as logs:
            event = collect(VALID, FakeAdapter([error]))[0]
        self.assertEqual(event["code"], "STRANDS_ERROR")
        self.assertEqual(event["message"], FAILURE_MESSAGE)
        self.assertIn("arn:secret", "\n".join(logs.output))

    def test_raised_error_becomes_run_error(self):
        with self.assertLogs("runs", level=logging.ERROR):
            events = collect(VALID, FakeAdapter([text_event()], RuntimeError("arn:secret")))
        self.assertEqual(events[-1]["type"], "RUN_ERROR")
        self.assertEqual(events[-1]["code"], "AGENT_ERROR")
        self.assertEqual(events[-1]["message"], FAILURE_MESSAGE)


class Lazy(unittest.TestCase):
    def test_builds_once_on_first_run_only(self):
        built = []

        def factory():
            built.append(1)
            return FakeAdapter([text_event()])

        adapter = LazyAdapter(factory)
        self.assertEqual(built, [])
        collect(VALID, adapter)
        collect(VALID, adapter)
        self.assertEqual(built, [1])

    def test_failed_build_is_a_run_error_and_retries(self):
        attempts = []

        def factory():
            attempts.append(1)
            if len(attempts) == 1:
                raise RuntimeError("arn:secret")
            return FakeAdapter([text_event()])

        adapter = LazyAdapter(factory)
        with self.assertLogs("runs", level=logging.ERROR):
            events = collect(VALID, adapter)
        self.assertEqual(events[-1]["code"], "AGENT_ERROR")
        self.assertNotIn("arn:secret", str(events))
        self.assertEqual(collect(VALID, adapter)[0]["type"], "TEXT_MESSAGE_CONTENT")

    def test_passes_invocation_state_through(self):
        inner = FakeAdapter([text_event()])
        cohort = {"filter": None, "revision": 1}
        collect({**VALID, "state": {"cohort": cohort}}, LazyAdapter(lambda: inner))
        self.assertEqual(inner.invocation_state, {"cohort": cohort})

    def test_closes_inner_stream_on_disconnect(self):
        inner = FakeAdapter([text_event("one"), text_event("two")])

        async def go():
            stream = handle_run(VALID, LazyAdapter(lambda: inner))
            await stream.__anext__()
            await stream.aclose()
        asyncio.run(go())
        self.assertTrue(inner.closed)

    def test_importing_main_does_not_connect(self):
        env = {**os.environ, "GATEWAY_URL": "https://example.invalid", "MODEL_ID": "x", "AGENT_REGION": "us-west-2"}
        result = subprocess.run([sys.executable, "-c", "import main"], env=env, capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr[-500:])


if __name__ == "__main__":
    unittest.main()
