"""Filter merging. Fixtures have the shape buildCohortGqlOperator gives for 'and' filter sets."""
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "lambda"))
from cohort_filter import apply_changes, label, simple_fields  # noqa: E402

RACE_BLACK = {"and": [{"in": {"demographic.race": ["black or african american"]}}]}
RACE_WHITE_MALE = {"and": [{"in": {"demographic.race": ["white"]}},
                           {"in": {"demographic.gender": ["male"]}}]}
CASE_IDS = {"and": [{"in": {"case_id": ["SYNTH-CASE-0001", "SYNTH-CASE-0002"]}}]}
FIVE_HUNDRED_CASE_IDS = {"and": [{"in": {"case_id": [f"SYNTH-CASE-{n:04d}" for n in range(500)]}}]}


def change(field, values, op="set"):
    return {"field": field, "values": values, "op": op}


class ApplyChanges(unittest.TestCase):
    def test_set_adds_a_new_field(self):
        result = apply_changes(RACE_BLACK, [change("demographic.gender", ["male"])])
        self.assertEqual(result, {"and": [{"in": {"demographic.race": ["black or african american"]}},
                                          {"in": {"demographic.gender": ["male"]}}]})

    def test_set_replaces_the_same_field(self):
        result = apply_changes(RACE_BLACK, [change("demographic.race", ["white"])])
        self.assertEqual(result, {"and": [{"in": {"demographic.race": ["white"]}}]})

    def test_set_from_no_filter(self):
        self.assertEqual(apply_changes(None, [change("demographic.race", ["white"])]),
                         {"and": [{"in": {"demographic.race": ["white"]}}]})

    def test_bare_in_is_read(self):
        bare = {"in": {"demographic.race": ["white"]}}
        result = apply_changes(bare, [change("demographic.gender", ["male"])])
        self.assertEqual(simple_fields(result), {"demographic.race": ["white"],
                                                 "demographic.gender": ["male"]})

    def test_remove_drops_a_field(self):
        result = apply_changes(RACE_WHITE_MALE, [change("demographic.race", [], "remove")])
        self.assertEqual(result, {"and": [{"in": {"demographic.gender": ["male"]}}]})

    def test_removing_the_last_field_gives_none(self):
        self.assertIsNone(apply_changes(RACE_BLACK, [change("demographic.race", [], "remove")]))

    def test_case_id_filter_is_kept_opaque(self):
        result = apply_changes(CASE_IDS, [change("demographic.race", ["white"])])
        self.assertIn({"in": {"case_id": ["SYNTH-CASE-0001", "SYNTH-CASE-0002"]}}, result["and"])
        self.assertEqual(simple_fields(result), {"demographic.race": ["white"]})

    def test_input_is_not_changed(self):
        before = {"and": [{"in": {"demographic.race": ["white"]}}]}
        apply_changes(before, [change("demographic.race", ["asian"])])
        self.assertEqual(before, {"and": [{"in": {"demographic.race": ["white"]}}]})

    def test_unknown_shape_raises(self):
        for shape in ({"or": [{"in": {"demographic.race": ["white"]}}]},
                      {"and": [{"nested": {"path": "x", "in": {"y": ["z"]}}}]},
                      {"=": {"demographic.race": "white"}}, ["x"]):
            with self.subTest(shape=shape), self.assertRaises(ValueError):
                apply_changes(shape, [change("demographic.gender", ["male"])])


class Label(unittest.TestCase):
    def test_label_lists_simple_fields(self):
        self.assertEqual(label(RACE_BLACK), "Race: black or african american")

    def test_label_joins_fields(self):
        self.assertEqual(label(RACE_WHITE_MALE), "Race: white; Sex: male")

    def test_label_never_lists_case_ids(self):
        self.assertEqual(label(FIVE_HUNDRED_CASE_IDS), "Selected cases")

    def test_label_of_no_filter(self):
        self.assertEqual(label(None), "All cases")


if __name__ == "__main__":
    unittest.main()
