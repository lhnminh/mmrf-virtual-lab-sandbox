"""The tool schema Gateway publishes must match the tools the Lambda serves."""

import importlib.util
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

os.environ.setdefault("NEPTUNE_URI", "bolt://unused:7687")  # read at import; these tests never connect
spec = importlib.util.spec_from_file_location("kg_handler_schema", ROOT / "lambda/handler.py")
handler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(handler)

TOOLS = json.loads((ROOT / "tools.json").read_text())
ENVELOPE = {"contract_version", "result_type", "summary", "observations", "interpretation", "graph", "evidence",
            "limitations", "trace"}


def required(name):
    tool = next(t for t in TOOLS if t["name"] == name)
    return tool["inputSchema"].get("required", [])


def test_schema_lists_exactly_the_handlers_tools():
    assert {tool["name"] for tool in TOOLS} == set(handler.TOOLS)


def test_required_inputs_match_the_team_contract():
    assert required("kg_search_entities") == ["text"]
    assert required("kg_get_phenotypes") == ["disease_id"]
    assert required("kg_get_mechanism_paths") == ["disease_id"]
    assert required("kg_get_evidence") == []
    assert required("kg_run_readonly_query") == ["query"]


def test_every_tool_declares_the_envelope():
    for tool in TOOLS:
        assert ENVELOPE <= set(tool["outputSchema"]["properties"])


def test_only_the_query_tool_declares_a_table():
    assert [t["name"] for t in TOOLS if "table" in t["outputSchema"]["properties"]] == ["kg_run_readonly_query"]
