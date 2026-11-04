"""The adapter must keep its Gateway connection alive after it's built."""
import gc
import os
import unittest
from unittest import mock

os.environ.setdefault("GATEWAY_URL", "https://example.invalid")
os.environ.setdefault("MODEL_ID", "x")
os.environ.setdefault("AGENT_REGION", "us-west-2")

from strands.tools.tool_provider import ToolProvider  # noqa: E402

import main  # noqa: E402


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


if __name__ == "__main__":
    unittest.main()
