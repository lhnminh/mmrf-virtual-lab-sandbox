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

    def test_separates_comparing_from_filtering(self):
        for words in ("show_survival", "compareBy", "leave the cohort as it is", "never write p = 0"):
            with self.subTest(words=words):
                self.assertIn(words, main.SYSTEM_PROMPT)

    def test_numbers_keep_the_summary_unit(self):
        self.assertIn("with the unit the summary gives it", main.SYSTEM_PROMPT)

    def test_selected_cohort_case_count_is_the_one_outside_number(self):
        self.assertIn("selected cohort's case count", main.SYSTEM_PROMPT)

    def test_does_not_mention_a_filter(self):
        self.assertNotIn("filter", main.SYSTEM_PROMPT.lower())


class KnowledgeGraphClients(unittest.TestCase):
    def test_one_gateway_client_without_a_graph_url(self):
        with mock.patch.dict(os.environ), mock.patch.object(main, "MCPClient"):
            os.environ.pop("KG_GATEWAY_URL", None)
            self.assertEqual(len(main.gateway_clients()), 1)

    def test_two_gateway_clients_with_a_graph_url(self):
        with mock.patch.dict(os.environ, {"KG_GATEWAY_URL": "https://graph.invalid/mcp"}), \
                mock.patch.object(main, "MCPClient") as client, \
                mock.patch.object(main, "aws_iam_streamablehttp_client") as transport:
            clients = main.gateway_clients()
            client.call_args.args[0]()
        self.assertEqual(len(clients), 2)
        self.assertEqual(transport.call_args.kwargs["endpoint"], "https://graph.invalid/mcp")

    def test_a_stopped_probe_client_is_not_handed_to_the_agent(self):
        made = [mock.MagicMock(name="virtual_lab"), mock.MagicMock(name="probe"), mock.MagicMock(name="graph")]
        with mock.patch.dict(os.environ, {"KG_GATEWAY_URL": "https://graph.invalid/mcp"}), \
                mock.patch.object(main, "MCPClient", side_effect=made):
            clients = main.gateway_clients()
        made[1].__exit__.assert_called_once()
        self.assertEqual(clients, [made[0], made[2]])

    def test_graph_outage_leaves_virtual_lab_tools_and_warns(self):
        broken = mock.MagicMock()
        broken.__enter__.side_effect = RuntimeError("gateway down")
        with mock.patch.dict(os.environ, {"KG_GATEWAY_URL": "https://graph.invalid/mcp"}), \
                mock.patch.object(main, "MCPClient", side_effect=[mock.MagicMock(), broken]), \
                self.assertLogs("main", level="WARNING") as logs:
            clients = main.gateway_clients()
        self.assertEqual(len(clients), 1)
        self.assertIn("knowledge graph", logs.output[0])

    def test_build_adapter_uses_the_graph_prompt_when_configured(self):
        with mock.patch.dict(os.environ, {"KG_GATEWAY_URL": "https://graph.invalid/mcp"}), \
                mock.patch.object(main, "gateway_clients", return_value=[FakeProvider()]):
            adapter = main.build_adapter()
        self.assertIsNotNone(adapter)
        self.assertIn(main.KNOWLEDGE_GRAPH_RULES, main._templates[-1].system_prompt)


class KnowledgeGraphPrompt(unittest.TestCase):
    def test_graph_rules_only_when_the_graph_is_configured(self):
        with mock.patch.dict(os.environ):
            os.environ.pop("KG_GATEWAY_URL", None)
            self.assertEqual(main.system_prompt(), main.SYSTEM_PROMPT)
        with mock.patch.dict(os.environ, {"KG_GATEWAY_URL": "https://graph.invalid/mcp"}):
            self.assertIn(main.KNOWLEDGE_GRAPH_RULES, main.system_prompt())

    def test_graph_rules_say_what_the_spec_requires(self):
        for words in ("limitations", "none recorded", "none exists", "treatment", "observations", "interpretation",
                      "published knowledge", "summary"):
            with self.subTest(words=words):
                self.assertIn(words, main.KNOWLEDGE_GRAPH_RULES)

    def test_graph_rules_do_not_mention_a_filter(self):
        self.assertNotIn("filter", main.KNOWLEDGE_GRAPH_RULES.lower())

    def test_synthetic_notice_applies_to_virtual_lab_answers(self):
        self.assertIn("When you used Virtual Lab tools", main.SYSTEM_PROMPT)


if __name__ == "__main__":
    unittest.main()
