"""show_oncomatrix tests, with a fake Virtual Lab client."""
import json
import pathlib
import re
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "lambda"))
from tool_show_oncomatrix import show_oncomatrix  # noqa: E402
from virtual_lab_client import ClientError  # noqa: E402

RACE_BLACK = {"and": [{"in": {"demographic.race": ["black or african american"]}}]}
RANKING = [("KRAS", 148), ("NRAS", 113), ("DIS3", 100), ("TP53", 60)]
SAMPLES = {
    "KRAS": {"SYNTH-S-1", "SYNTH-S-2", "SYNTH-S-3"},
    "NRAS": {"SYNTH-S-3", "SYNTH-S-4"},  # S-3 overlaps with KRAS.
    "DIS3": {"SYNTH-S-1", "SYNTH-S-5"},
    "TP53": {"SYNTH-S-6"},
}


class FakeClient:
    def __init__(self, ranking=RANKING, fail=None):
        self.ranking, self.fail = ranking, fail
        self.top_calls = []

    def case_count(self, cohort_filter):
        if self.fail:
            raise self.fail
        return 334 if cohort_filter else 1000

    def top_genes(self, cohort_filter, max_genes=50):
        if self.fail:
            raise self.fail
        self.top_calls.append(max_genes)
        return self.ranking

    def lookup_gene(self, name):
        return {"name": name}

    def sample_ids(self, gene_info, cohort_filter):
        return SAMPLES[gene_info["name"]]


def run(args=None, client=None):
    return show_oncomatrix({"cohortFilter": RACE_BLACK, **(args or {})}, client or FakeClient())


class ShowOncomatrix(unittest.TestCase):
    def test_ok_states_cases_and_samples_separately(self):
        r = run()
        self.assertEqual(r["status"], "ok")
        self.assertEqual((r["caseCount"], r["sampleCount"]), (334, 6))
        self.assertIn("334 cases", r["summary"])
        self.assertIn("6 samples", r["summary"])
        self.assertEqual(r["genes"][0], {"gene": "KRAS", "count": 148})
        self.assertEqual(r["cohort"], {"label": "Race: black or african american", "caseCount": 334})
        self.assertEqual(r["plot"], {"type": "oncomatrix"})
        self.assertNotIn("followUps", r)

    def test_samples_are_the_union_across_genes(self):
        self.assertEqual(run()["sampleCount"], 6)

    def test_max_genes_counts_only_samples_of_the_genes_shown(self):
        client = FakeClient()
        r = run({"maxGenes": 3}, client)
        self.assertEqual([g["gene"] for g in r["genes"]], ["KRAS", "NRAS", "DIS3"])
        self.assertEqual(r["sampleCount"], 5)  # TP53's S-6 is not drawn.
        self.assertIn("5 samples with a mutation in these genes", r["summary"])
        self.assertEqual(r["plot"], {"type": "oncomatrix", "maxGenes": 3})
        self.assertGreaterEqual(client.top_calls[0], 50)
        self.assertNotIn("TP53", r["summary"])

    def test_max_genes_above_default_is_requested_in_full(self):
        client = FakeClient()
        run({"maxGenes": 80}, client)
        self.assertGreaterEqual(client.top_calls[0], 80)

    def test_bad_max_genes_is_an_error(self):
        for bad in (0, -1, "3", 2.5, True, None):
            with self.subTest(bad=bad):
                r = run({"maxGenes": bad})
                self.assertEqual((r["status"], r["step"]), ("error", "invalid_input"))

    def test_no_genes_is_no_data_without_a_plot(self):
        r = run(client=FakeClient(ranking=[]))
        self.assertEqual(r["status"], "no_data")
        self.assertNotIn("plot", r)
        self.assertIn("334 cases", r["summary"])

    def test_no_cohort_means_all_cases(self):
        r = show_oncomatrix({}, FakeClient())
        self.assertEqual(r["caseCount"], 1000)
        self.assertEqual(r["cohort"]["label"], "All cases")
        r = show_oncomatrix({"cohortFilter": None}, FakeClient())
        self.assertEqual(r["caseCount"], 1000)

    def test_missing_gene_lookup_is_unhealthy(self):
        client = FakeClient()
        client.lookup_gene = lambda name: None
        r = run(client=client)
        self.assertEqual((r["status"], r["step"]), ("error", "unhealthy"))

    def test_client_failure_names_the_step(self):
        r = run(client=FakeClient(fail=ClientError("paint_failed", "boom")))
        self.assertEqual((r["status"], r["step"]), ("error", "paint_failed"))

    def test_no_sample_or_case_ids_in_result(self):
        self.assertNotIn("SYNTH-", json.dumps(run()))

    def test_summary_holds_every_number_in_the_result(self):
        r = run()
        for n in (r["caseCount"], r["sampleCount"], *[g["count"] for g in r["genes"]]):
            self.assertIn(str(n), r["summary"])
        self.assertEqual(
            r["summary"],
            "334 cases, 6 samples with a mutation in these genes. KRAS (148 samples), NRAS (113 samples), "
            "DIS3 (100 samples), TP53 (60 samples) are the most frequently mutated.")

    def test_gene_counts_use_the_same_unit_as_show_lollipop(self):
        self.assertIn("KRAS (148 samples)", run()["summary"])

    def test_registered_with_the_handler(self):
        import handler
        self.assertIs(handler.CLIENT_TOOLS["show_oncomatrix"], show_oncomatrix)


if __name__ == "__main__":
    unittest.main()
