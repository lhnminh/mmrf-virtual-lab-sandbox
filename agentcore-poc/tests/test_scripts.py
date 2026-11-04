"""Operator script tests. Pure logic only: no AWS."""
import hashlib
import json
import pathlib
import sys
import tempfile
import unittest

from ag_ui.core import RunAgentInput

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "scripts"))
import invoke  # noqa: E402
import set_access_secret  # noqa: E402


class RunInput(unittest.TestCase):
    def test_run_input_is_valid(self):
        parsed = RunAgentInput.model_validate(invoke.build_run_input("q", "t", []))
        self.assertEqual(parsed.thread_id, "t")
        self.assertEqual(parsed.messages[-1].role, "user")
        self.assertEqual(parsed.messages[-1].content, "q")

    def test_history_comes_before_prompt(self):
        history = [{"role": "user", "content": "one"}, {"role": "assistant", "content": "two"}]
        parsed = RunAgentInput.model_validate(invoke.build_run_input("three", "t", history))
        self.assertEqual([m.content for m in parsed.messages], ["one", "two", "three"])

    def test_session_id_matches_frontend(self):
        self.assertEqual(invoke.session_id("t"), hashlib.sha256(b"t").hexdigest())


class CohortFile(unittest.TestCase):
    COHORT = {"filter": {"and": [{"in": {"demographic.race": ["black or african american"]}}]},
              "label": "Race: black or african american", "caseCount": 334,
              "revision": 2, "changedOutsideChat": False}

    def write(self, value):
        file = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        self.addCleanup(pathlib.Path(file.name).unlink)
        file.write(value)
        file.close()
        return file.name

    def test_run_input_has_no_cohort_by_default(self):
        self.assertEqual(invoke.build_run_input("q", "t", [])["state"], {})

    def test_cohort_goes_in_state_and_nowhere_else(self):
        run_input = invoke.build_run_input("q", "t", [], self.COHORT)
        parsed = RunAgentInput.model_validate(run_input)
        self.assertEqual(parsed.state, {"cohort": self.COHORT})
        self.assertEqual(parsed.context, [])
        self.assertEqual(parsed.messages[-1].content, "q")

    def test_load_cohort_reads_the_file(self):
        self.assertEqual(invoke.load_cohort(self.write(json.dumps(self.COHORT))), self.COHORT)

    def test_load_cohort_keeps_only_the_cohort_fields(self):
        path = self.write(json.dumps({**self.COHORT, "other": "x"}))
        self.assertEqual(invoke.load_cohort(path), self.COHORT)

    def test_load_cohort_accepts_a_null_filter(self):
        path = self.write(json.dumps({"filter": None, "label": "All cases"}))
        self.assertEqual(invoke.load_cohort(path), {"filter": None, "label": "All cases"})

    def test_load_cohort_requires_a_filter_key(self):
        for value in ('{"label": "All cases"}', "[]"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                invoke.load_cohort(self.write(value))


class Sse(unittest.TestCase):
    def test_parse_sse_line(self):
        self.assertEqual(invoke.parse_sse_line('data: {"type":"RUN_STARTED"}'), {"type": "RUN_STARTED"})

    def test_ignores_everything_else(self):
        for line in ("", ": comment", "event: x"):
            with self.subTest(line=line):
                self.assertIsNone(invoke.parse_sse_line(line))


class Login(unittest.TestCase):
    def write(self, value):
        file = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        self.addCleanup(pathlib.Path(file.name).unlink)
        file.write(value)
        file.close()
        return file.name

    def test_load_login_keeps_only_the_login(self):
        path = self.write(json.dumps({"username": "team", "password": "pw", "other": "x"}))
        self.assertEqual(set_access_secret.load_login(path), {"username": "team", "password": "pw"})

    def test_load_login_requires_both_fields(self):
        path = self.write(json.dumps({"username": "visible-in-file"}))
        with self.assertRaises(ValueError) as caught:
            set_access_secret.load_login(path)
        self.assertNotIn("visible-in-file", str(caught.exception))

    def test_load_login_hides_invalid_json(self):
        path = self.write("visible-in-file")
        with self.assertRaises(ValueError) as caught:
            set_access_secret.load_login(path)
        self.assertNotIn("visible-in-file", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
