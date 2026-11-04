"""show_survival tests, with a fake Virtual Lab client and a real-shaped reply."""
import copy
import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "lambda"))
from tool_show_survival import show_survival  # noqa: E402
from virtual_lab_client import ClientError  # noqa: E402

CGS_REPLY = json.loads((pathlib.Path(__file__).parent / "fixtures" / "survival-cgs-reply.json").read_text())
KEYS = CGS_REPLY["keys"]
TERM = {"id": "overall_survival", "name": "Synthetic overall survival", "type": "survival", "unit": "years"}
CASE_IDS = {"and": [{"in": {"case_id": ["SYNTH-CASE-0001", "SYNTH-CASE-0002"]}}]}


def single_curve(cases=1000, deaths=601, censored=399, final=0.3, series=""):
    return {"keys": KEYS, "case": [["", series, 0, 1, 1, 1, 0, 0, cases],
                                   ["", series, 6.01, 0.5, 0.45, 0.55, deaths - 1, 0, cases],
                                   ["", series, 9.0, final, 0.2, 0.4, 1, censored, 100]],
            "refs": {"orderedKeys": {"series": ["*"]}}}


def with_p(value):
    reply = copy.deepcopy(CGS_REPLY)
    reply["tests"][""][0]["pvalue"] = value
    return reply


def race_reply(zero=False):
    rows = []
    for name, cases in (("asian", 332), ("black", 334), ("white", 334)):
        rows += single_curve(cases, 100, 50, series=name)["case"]
    pairs = [("asian", "black", "0.29"), ("asian", "white", "0" if zero else "0.34"), ("black", "white", "0.95")]
    return {"keys": KEYS, "case": rows,
            "tests": {"": [{"series1": a, "series2": b, "pvalue": p} for a, b, p in pairs]}}


class FakeClient:
    def __init__(self, reply=None, count=None, fail=None, known=True):
        self.reply = reply if reply is not None else single_curve()
        self.count, self.fail, self.known = count, fail, known
        self.calls = []

    def survival_term(self):
        self.calls.append("survival_term")
        if self.fail:
            raise self.fail
        return TERM

    def comparison_term(self, term_id):
        self.calls.append(term_id)
        return {"id": term_id} if self.known else None

    def survival(self, survival_term, compare_term, cohort_filter):
        self.calls.append(("survival", compare_term, cohort_filter))
        return self.reply

    def case_count(self, cohort_filter):
        if self.count is not None:
            return self.count
        return sum(row[8] for row in _first_rows(self.reply))


def _first_rows(reply):
    seen, rows = set(), []
    for row in reply["case"]:
        if row[1] not in seen:
            seen.add(row[1])
            rows.append(row)
    return rows


class Numbers(unittest.TestCase):
    def test_two_groups_give_the_exact_summary(self):
        result = show_survival({"compareBy": "CGS risk"}, FakeClient(CGS_REPLY))
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["summary"], (
            "1000 cases, overall survival, compared by CGS risk. "
            "High risk: 334 cases, 292 deaths, 42 censored, median 3.21 years. "
            "Standard risk: 666 cases, 309 deaths, 357 censored, median 8.92 years. "
            "Log-rank P-value: 4.6e-14. Medians are calculated from the curve."))
        self.assertEqual(result["groups"], ["High risk", "Standard risk"])
        self.assertEqual(result["comparedBy"], "CGS risk")
        self.assertEqual(result["plot"], {"type": "survival", "term": "overall_survival",
                                          "compareBy": "cgs_risk_category"})
        self.assertEqual(result["cohort"]["caseCount"], 1000)

    def test_one_curve_has_no_groups_or_compare(self):
        result = show_survival({}, FakeClient())
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["summary"], "1000 cases, overall survival. 601 deaths, 399 censored, "
                                            "median 6.01 years. Medians are calculated from the curve.")
        self.assertEqual(result["plot"], {"type": "survival", "term": "overall_survival"})
        self.assertNotIn("groups", result)
        self.assertNotIn("comparedBy", result)

    def test_zero_p_value_is_explained(self):
        summary = show_survival({"compareBy": "CGS risk"}, FakeClient(with_p("0")))["summary"]
        self.assertIn("Log-rank P-value shows 0 on the chart, meaning too small to calculate exactly.", summary)
        self.assertNotIn("p = 0", summary)
        self.assertNotIn("P-value: 0", summary)

    def test_small_p_value_starting_with_zero_is_not_called_zero(self):
        summary = show_survival({"compareBy": "CGS risk"}, FakeClient(with_p("0.04")))["summary"]
        self.assertIn("Log-rank P-value: 0.04.", summary)

    def test_three_groups_list_every_pair(self):
        summary = show_survival({"compareBy": "Race"}, FakeClient(race_reply()))["summary"]
        self.assertIn("Log-rank P-values: asian vs black 0.29, asian vs white 0.34, black vs white 0.95.", summary)

    def test_three_groups_explain_a_zero(self):
        summary = show_survival({"compareBy": "Race"}, FakeClient(race_reply(zero=True)))["summary"]
        self.assertIn("asian vs white shows 0 on the chart, meaning too small to calculate exactly", summary)

    def test_comparison_without_tests_says_so(self):
        reply = copy.deepcopy(CGS_REPLY)
        del reply["tests"]
        result = show_survival({"compareBy": "CGS risk"}, FakeClient(reply))
        self.assertEqual(result["status"], "ok")
        self.assertIn("The service gave no log-rank P-value.", result["summary"])

    def test_median_not_reached(self):
        reply = {"keys": KEYS, "case": [["", "", 0, 1, 1, 1, 0, 0, 10], ["", "", 5, 0.8, 0.7, 0.9, 2, 8, 10]]}
        self.assertIn("median not reached", show_survival({}, FakeClient(reply))["summary"])

    def test_median_at_exactly_half(self):
        reply = {"keys": KEYS, "case": [["", "", 0, 1, 1, 1, 0, 0, 10], ["", "", 4, 0.5, 0.4, 0.6, 5, 5, 10]]}
        self.assertIn("median 4.00 years", show_survival({}, FakeClient(reply))["summary"])

    def test_counts_of_one_are_singular(self):
        reply = {"keys": KEYS, "case": [["", "", 0, 1, 1, 1, 0, 0, 1], ["", "", 4, 0, 0, 0, 1, 0, 1]]}
        self.assertIn("1 case, overall survival. 1 death, 0 censored", show_survival({}, FakeClient(reply))["summary"])

    def test_count_mismatch_is_stated(self):
        result = show_survival({}, FakeClient(count=1005))
        self.assertEqual(result["status"], "ok")
        self.assertIn("The chart counts 1000 cases, and the cohort has 1005.", result["summary"])
        self.assertEqual(result["cohort"]["caseCount"], 1005)


class CompareBy(unittest.TestCase):
    def test_spellings_resolve(self):
        cases = {" CGS Risk ": "cgs_risk_category", "cgs risk category": "cgs_risk_category", "risk": "cgs_risk_category",
                 "kras": "kras_status", "KRAS status": "kras_status", "GENDER": "gender", "sex": "gender",
                 "Race": "race"}
        for asked, field in cases.items():
            with self.subTest(asked=asked):
                client = FakeClient(CGS_REPLY)
                self.assertEqual(show_survival({"compareBy": asked}, client)["plot"]["compareBy"], field)
                self.assertIn(field, client.calls)

    def test_blank_compare_by_means_one_curve(self):
        for value in ("", "  ", None):
            with self.subTest(value=value):
                result = show_survival({"compareBy": value}, FakeClient())
                self.assertEqual(result["status"], "ok")
                self.assertNotIn("compareBy", result["plot"])

    def test_non_string_is_invalid_input(self):
        result = show_survival({"compareBy": 7}, FakeClient())
        self.assertEqual((result["status"], result["step"]), ("error", "invalid_input"))

    def test_unsupported_makes_no_call(self):
        client = FakeClient()
        result = show_survival({"compareBy": "TP53"}, client)
        self.assertEqual(result["status"], "unsupported_comparison")
        self.assertEqual(result["summary"], "There's no survival comparison by 'TP53' yet. "
                                            "Available: CGS risk, KRAS status, Sex, Race.")
        self.assertEqual(result["available"], ["CGS risk", "KRAS status", "Sex", "Race"])
        self.assertNotIn("plot", result)
        self.assertEqual(client.calls, [])

    def test_listed_field_missing_from_the_dataset_is_a_failure(self):
        result = show_survival({"compareBy": "Race"}, FakeClient(known=False))
        self.assertEqual((result["status"], result["step"]), ("error", "unhealthy"))


class Outcomes(unittest.TestCase):
    def test_empty_reply_is_no_cases(self):
        result = show_survival({}, FakeClient({"keys": KEYS, "case": []}, count=0))
        self.assertEqual(result["status"], "no_cases")
        self.assertEqual(result["summary"], "This cohort has no cases, so there's no survival curve.")
        self.assertEqual(result["cohort"]["caseCount"], 0)
        self.assertNotIn("plot", result)

    def test_one_group(self):
        reply = {"keys": KEYS, "case": [row for row in CGS_REPLY["case"] if row[1] == "High risk"]}
        result = show_survival({"compareBy": "CGS risk"}, FakeClient(reply))
        self.assertEqual(result["status"], "one_group")
        self.assertTrue(result["summary"].startswith("Comparing by CGS risk leaves one group in this cohort: High risk. "))
        self.assertIn("334 cases", result["summary"])
        self.assertNotIn("P-value", result["summary"])
        self.assertEqual(result["plot"]["compareBy"], "cgs_risk_category")

    def test_case_ids_stay_out_of_the_result(self):
        client = FakeClient()
        result = show_survival({"cohortFilter": CASE_IDS}, client)
        text = json.dumps(result)
        self.assertNotIn("SYNTH-CASE", text)
        self.assertNotIn("cohortFilter", text)
        self.assertEqual(client.calls[-1][2], CASE_IDS)

    def test_client_error_is_a_failed_step(self):
        result = show_survival({}, FakeClient(fail=ClientError("auth_failed", "The Virtual Lab refused the login.")))
        self.assertEqual((result["status"], result["step"]), ("error", "auth_failed"))
        self.assertNotIn("cases", result["summary"])

    def test_malformed_row_is_a_failed_step_with_no_numbers(self):
        reply = {"keys": KEYS, "case": [["", "", 0, 1, 1, 1, "x", 0, 10]]}
        result = show_survival({}, FakeClient(reply))
        self.assertEqual((result["status"], result["step"]), ("error", "unhealthy"))


if __name__ == "__main__":
    unittest.main()
