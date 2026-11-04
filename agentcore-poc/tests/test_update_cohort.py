"""update_cohort tests, with a fake Virtual Lab client."""
import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "lambda"))
from cohort_fields import Ambiguous, resolve_field, resolve_values  # noqa: E402
from tool_update_cohort import update_cohort  # noqa: E402
from virtual_lab_client import ClientError  # noqa: E402

VALUES = {
    "demographic.race": [("white", 334), ("black or african american", 334), ("asian", 332)],
    "demographic.ethnicity": [("hispanic or latino", 502), ("not hispanic or latino", 498)],
    "demographic.gender": [("female", 500), ("male", 500)],
}
RACE_BLACK = {"and": [{"in": {"demographic.race": ["black or african american"]}}]}
CASE_IDS = {"and": [{"in": {"case_id": ["SYNTH-CASE-0001", "SYNTH-CASE-0002"]}}]}


class FakeClient:
    def __init__(self, counts=None, fail=None):
        self.counts = counts or {}
        self.fail = fail

    def case_count(self, cohort_filter):
        if self.fail:
            raise self.fail
        return self.counts.get(json.dumps(cohort_filter, sort_keys=True), 1000 if not cohort_filter else 334)

    def field_values(self, field, cohort_filter=None):
        if self.fail:
            raise self.fail
        return VALUES.get(field, [])


def run(changes, base=None, client=None):
    args = {"changes": changes}
    if base is not None:
        args["cohortFilter"] = base
    return update_cohort(args, client or FakeClient())


def one(field, values, op="set"):
    return [{"field": field, "values": values, "op": op}]


class Outcomes(unittest.TestCase):
    def test_black_maps_to_the_data_value(self):
        result = run(one("race", ["Black"]))
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["changes"], [{"field": "demographic.race", "label": "Race",
                                              "values": ["black or african american"], "op": "set"}])
        self.assertEqual(result["filter"], RACE_BLACK)
        self.assertEqual((result["casesBefore"], result["casesAfter"]), (1000, 334))
        self.assertEqual(result["cohort"], {"label": "Race: black or african american", "caseCount": 334})
        self.assertIn("1000", result["summary"])
        self.assertIn("334", result["summary"])

    def test_sex_synonym_and_value_synonym(self):
        result = run(one("sex", ["men"]))
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["changes"][0]["field"], "demographic.gender")
        self.assertEqual(result["changes"][0]["values"], ["male"])

    def test_remove_has_no_values(self):
        result = run(one("race", ["ignored"], "remove"), base=RACE_BLACK,
                     client=FakeClient({json.dumps(RACE_BLACK, sort_keys=True): 334, "null": 1000}))
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["changes"][0]["values"], [])
        self.assertIsNone(result["filter"])
        self.assertEqual(result["cohort"], {"label": "All cases", "caseCount": 1000})

    def test_hispanic_is_ambiguous(self):
        result = run(one("ethnicity", ["Hispanic"]))
        self.assertEqual(result["status"], "ambiguous")
        self.assertEqual(result["field"], "demographic.ethnicity")
        self.assertEqual(sorted(result["options"]), ["hispanic or latino", "not hispanic or latino"])
        self.assertNotIn("filter", result)

    def test_smokers_is_unknown_field(self):
        result = run(one("smokers", ["yes"]))
        self.assertEqual(result["status"], "unknown_field")
        self.assertIsInstance(result["closest"], list)
        self.assertLessEqual(len(result["closest"]), 5)
        self.assertNotIn("filter", result)

    def test_misspelt_field_has_closest(self):
        result = run(one("ethnicty", ["x"]))
        self.assertEqual(result["status"], "unknown_field")
        self.assertEqual(result["closest"][0]["field"], "demographic.ethnicity")

    def test_unknown_value_lists_available(self):
        result = run(one("race", ["martian"]))
        self.assertEqual(result["status"], "unknown_value")
        self.assertEqual(sorted(result["available"]), ["asian", "black or african american", "white"])
        self.assertNotIn("filter", result)

    def test_age_is_unsupported(self):
        result = run(one("age at diagnosis", ["50"]))
        self.assertEqual(result["status"], "unsupported_field")
        self.assertNotIn("filter", result)

    def test_bare_age_is_unsupported_not_unknown(self):
        result = run(one("age", ["50"]))
        self.assertEqual(result["status"], "unsupported_field")
        self.assertIn("isn't supported yet", result["summary"])

    def test_zero_cases_would_be_empty(self):
        client = FakeClient({json.dumps(RACE_BLACK, sort_keys=True): 0})
        result = run(one("race", ["black"]), client=client)
        self.assertEqual(result["status"], "would_be_empty")
        self.assertEqual(result["caseCount"], 0)
        self.assertEqual(result["changes"][0]["values"], ["black or african american"])
        self.assertNotIn("filter", result)

    def test_changes_apply_together_or_not_at_all(self):
        result = run([{"field": "race", "values": ["white"], "op": "set"},
                      {"field": "sex", "values": ["robot"], "op": "set"}])
        self.assertEqual(result["status"], "unknown_value")
        self.assertNotIn("filter", result)

    def test_invalid_op_is_rejected_in_python(self):
        result = run(one("race", ["white"], "add"))
        self.assertEqual(result["status"], "error")
        self.assertNotIn("filter", result)

    def test_bad_inputs_are_errors(self):
        for changes in (None, [], "x", [{"field": "race"}], [{"field": "race", "op": "set", "values": []}],
                        [{"field": "race", "op": "set", "values": [1]}]):
            with self.subTest(changes=changes):
                self.assertEqual(update_cohort({"changes": changes}, FakeClient())["status"], "error")

    def test_client_failure_names_the_step(self):
        result = run(one("race", ["white"]), client=FakeClient(fail=ClientError("unreachable", "down")))
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["step"], "unreachable")

    def test_age_range_does_not_block_removing_sex(self):
        age = {">=": {"demographic.age_at_index": 50}}
        base = {"and": [age, {"in": {"demographic.gender": ["male"]}}]}
        result = run(one("sex", [], "remove"), base=base)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["filter"], {"and": [age]})

    def test_unreadable_base_filter_tells_the_model_what_to_say(self):
        result = run(one("race", ["white"]), base={"or": []})
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["step"], "unsupported_filter")
        self.assertIn("Cohort Builder", result["summary"])
        self.assertNotIn("filter", result)

    def test_absent_or_none_cohort_filter_means_no_filter(self):
        for args in ({"changes": one("race", ["white"])},
                     {"changes": one("race", ["white"]), "cohortFilter": None}):
            self.assertEqual(update_cohort(args, FakeClient())["status"], "ok")


class Privacy(unittest.TestCase):
    def test_results_hold_no_case_ids(self):
        result = run(one("race", ["white"]), base=CASE_IDS)
        self.assertEqual(result["status"], "ok")
        self.assertIn("SYNTH-CASE-0001", json.dumps(result["filter"]))
        rest = {k: v for k, v in result.items() if k != "filter"}
        self.assertNotIn("SYNTH-CASE-", json.dumps(rest))
        self.assertEqual(result["cohort"]["label"], "Selected cases; Race: white")

    def test_only_filter_key_holds_the_filter(self):
        result = run(one("race", ["white"]), base=RACE_BLACK)
        rest = json.dumps({k: v for k, v in result.items() if k != "filter"})
        for word in ('"in"', '"and"', '"nested"'):
            self.assertNotIn(word, rest)


class Resolvers(unittest.TestCase):
    def test_exact_beats_substring(self):
        resolved = resolve_values("demographic.ethnicity", ["Hispanic or Latino"], VALUES["demographic.ethnicity"])
        self.assertEqual(resolved.values, ["hispanic or latino"])

    def test_whole_word_beats_substring(self):
        stages = [("I", 300), ("II", 400), ("III", 300)]
        resolved = resolve_values("diagnoses.iss_stage", ["I"], stages)
        self.assertEqual(resolved.values, ["I"])

    def test_hispanic_stays_ambiguous(self):
        resolved = resolve_values("demographic.ethnicity", ["Hispanic"], VALUES["demographic.ethnicity"])
        self.assertIsInstance(resolved, Ambiguous)

    def test_field_by_gen3_name_and_label(self):
        self.assertEqual(resolve_field("demographic.race").name, "demographic.race")
        self.assertEqual(resolve_field("Sex").name, "demographic.gender")
        self.assertEqual(resolve_field("ISS stage").name, "diagnoses.iss_stage")


if __name__ == "__main__":
    unittest.main()
