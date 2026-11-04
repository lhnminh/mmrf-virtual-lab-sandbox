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


AGE_RANGE = {">=": {"demographic.age_at_index": 50}}
NESTED = {"nested": {"path": "samples", "in": {"sample_type": ["Primary"]}}}
EXISTS = {"not": {"diagnoses.iss_stage": None}}
NUMERIC_IN = {"in": {"bone_assessments.number_of_lytic_lesions": [1, 2]}}


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

    def test_range_and_nested_entries_survive_a_set(self):
        for other in (AGE_RANGE, NESTED, EXISTS, NUMERIC_IN):
            with self.subTest(other=other):
                base = {"and": [{"in": {"demographic.race": ["black"]}}, other]}
                result = apply_changes(base, [change("demographic.race", ["white"])])
                self.assertEqual(result, {"and": [{"in": {"demographic.race": ["white"]}}, other]})

    def test_range_and_nested_entries_survive_a_remove(self):
        for other in (AGE_RANGE, NESTED, EXISTS, NUMERIC_IN):
            with self.subTest(other=other):
                base = {"and": [other, {"in": {"demographic.gender": ["male"]}}]}
                result = apply_changes(base, [change("demographic.gender", [], "remove")])
                self.assertEqual(result, {"and": [other]})

    def test_bare_opaque_entry_is_kept(self):
        result = apply_changes(AGE_RANGE, [change("demographic.race", ["white"])])
        self.assertEqual(result, {"and": [AGE_RANGE, {"in": {"demographic.race": ["white"]}}]})

    def test_unsafe_shapes_raise(self):
        race = [change("demographic.race", ["white"])]
        for shape, changes in (
                ({"or": [{"in": {"demographic.race": ["white"]}}]}, race),
                ({"and": [], "or": []}, race),
                ({"and": [{"in": {"demographic.race": [1, 2]}}]}, race),
                ({"and": [{"in": {"demographic.race": [1]}}]}, [change("demographic.race", [], "remove")]),
                (["x"], race)):
            with self.subTest(shape=shape), self.assertRaises(ValueError):
                apply_changes(shape, changes)


class Label(unittest.TestCase):
    def test_label_lists_simple_fields(self):
        self.assertEqual(label(RACE_BLACK), "Race: black or african american")

    def test_label_joins_fields(self):
        self.assertEqual(label(RACE_WHITE_MALE), "Race: white; Sex: male")

    def test_label_never_lists_case_ids(self):
        self.assertEqual(label(FIVE_HUNDRED_CASE_IDS), "Selected cases")

    def test_label_marks_other_filters(self):
        base = {"and": [{"in": {"demographic.race": ["white"]}}, AGE_RANGE]}
        self.assertEqual(label(base), "Race: white + other filters")
        self.assertEqual(label(AGE_RANGE), "Other filters")
        self.assertNotIn("50", label(base))

    def test_case_ids_alone_stay_selected_cases(self):
        self.assertEqual(label(CASE_IDS), "Selected cases")

    def test_label_of_unreadable_filter(self):
        self.assertEqual(label({"or": []}), "Selected cases")

    def test_label_of_no_filter(self):
        self.assertEqual(label(None), "All cases")


if __name__ == "__main__":
    unittest.main()
