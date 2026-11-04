"""tools.json is the Gateway tool schema. It must parse and never offer a cohort input."""
import json
import pathlib
import unittest

TOOLS = json.loads((pathlib.Path(__file__).resolve().parents[1] / "lambda" / "tools.json").read_text())


def property_names(schema):
    if isinstance(schema, dict):
        for name, value in schema.get("properties", {}).items():
            yield name
            yield from property_names(value)
        for key, value in schema.items():
            if key != "properties":
                yield from property_names(value)
    elif isinstance(schema, list):
        for item in schema:
            yield from property_names(item)


class ToolsJson(unittest.TestCase):
    def test_every_tool_has_the_full_schema_shape(self):
        self.assertIsInstance(TOOLS, list)
        self.assertTrue(TOOLS)
        for tool in TOOLS:
            with self.subTest(tool=tool.get("name")):
                self.assertTrue(tool["name"])
                self.assertTrue(tool["description"])
                self.assertEqual(tool["inputSchema"]["type"], "object")
                self.assertIsInstance(tool["inputSchema"]["properties"], dict)

    def test_no_tool_declares_a_cohort_input(self):
        for tool in TOOLS:
            for name in property_names(tool["inputSchema"]):
                with self.subTest(tool=tool["name"], property=name):
                    self.assertNotIn("cohort", name.lower())
                    self.assertNotIn("filter", name.lower())


if __name__ == "__main__":
    unittest.main()
