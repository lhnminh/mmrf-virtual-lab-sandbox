"""The adapter must keep its Gateway connection alive after it's built."""
import gc
import os
import unittest
from unittest import mock

os.environ.setdefault("GATEWAY_URL", "https://example.invalid")
os.environ.setdefault("MODEL_ID", "x")
os.environ.setdefault("AGENT_REGION", "us-west-2")

from strands.tools.executors import SequentialToolExecutor  # noqa: E402
from strands.tools.tool_provider import ToolProvider  # noqa: E402

import main  # noqa: E402
from cohort import UPDATE_TOOL, CohortHooks, prompt_context, state_from_update  # noqa: E402


class FakeProvider(ToolProvider):
    def __init__(self):
        self.consumers = set()
        self.ever_had_consumer = False

    async def load_tools(self, **kwargs):
        return []

    def add_consumer(self, consumer_id, **kwargs):
        self.consumers.add(consumer_id)
        self.ever_had_consumer = True

    def remove_consumer(self, consumer_id, **kwargs):
        self.consumers.discard(consumer_id)


class BuildAdapter(unittest.TestCase):
    def test_gateway_client_outlives_the_build(self):
        provider = FakeProvider()
        with mock.patch.object(main, "MCPClient", return_value=provider):
            adapter = main.build_adapter()
        gc.collect()
        self.assertTrue(provider.ever_had_consumer)
        self.assertTrue(provider.consumers, "the MCP client lost its last consumer, which stops it")
        self.assertIsNotNone(adapter)

    def test_adapter_is_wired_for_the_cohort(self):
        with mock.patch.object(main, "MCPClient", return_value=FakeProvider()):
            adapter = main.build_adapter()
        self.assertTrue(any(isinstance(hook, CohortHooks) for hook in adapter._hooks))
        self.assertIs(adapter.config.state_context_builder, prompt_context)
        self.assertIs(adapter.config.tool_behaviors[UPDATE_TOOL].state_from_result, state_from_update)

    def test_tools_in_one_turn_run_in_order(self):
        # A later tool in the same turn must get the cohort update_cohort just made.
        with mock.patch.object(main, "MCPClient", return_value=FakeProvider()):
            adapter = main.build_adapter()
        self.assertIsInstance(adapter._agent_kwargs["tool_executor"], SequentialToolExecutor)

    def test_gateway_timeout_is_60_seconds(self):
        with mock.patch.object(main, "MCPClient", return_value=FakeProvider()) as client, \
                mock.patch.object(main, "aws_iam_streamablehttp_client") as transport:
            main.build_adapter()
            client.call_args.args[0]()
        self.assertEqual(transport.call_args.kwargs["timeout"], 60)


class SystemPrompt(unittest.TestCase):
    def test_says_what_the_design_requires(self):
        for words in ("one-line plan", "update_cohort", "summary", "Observed", "Limits", "synthetic",
                      "Numbers are for the default view and don't reflect changes made in the chart",
                      "Interpretation", "Now using:", "cases and samples", "ambiguous", "failure", "buttons"):
            with self.subTest(words=words):
                self.assertIn(words, main.SYSTEM_PROMPT)

    def test_does_not_mention_a_filter(self):
        self.assertNotIn("filter", main.SYSTEM_PROMPT.lower())


if __name__ == "__main__":
    unittest.main()
