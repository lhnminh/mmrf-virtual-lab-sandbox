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


    def test_show_survival_can_be_selected_by_either_wording(self):
        tool = next(tool for tool in TOOLS if tool["name"] == "show_survival")
        for words in ("Correlation Plot", "Kaplan-Meier", "survival analysis"):
            with self.subTest(words=words):
                self.assertIn(words, tool["description"])
        self.assertIn("compareBy", tool["inputSchema"]["properties"])
        self.assertNotIn("compareBy", tool["inputSchema"].get("required", []))

    def test_show_gene_clustering_takes_an_optional_set_and_can_be_selected(self):
        tool = next(tool for tool in TOOLS if tool["name"] == "show_gene_clustering")
        self.assertEqual(list(tool["inputSchema"]["properties"]), ["geneSet"])
        self.assertEqual(tool["inputSchema"].get("required", []), [])
        self.assertIn("MSigDB", tool["description"])
        for words in ("gene expression clustering", "heatmap", "top 20", "no clusters or expression values"):
            with self.subTest(words=words):
                self.assertIn(words, tool["description"])


if __name__ == "__main__":
    unittest.main()
