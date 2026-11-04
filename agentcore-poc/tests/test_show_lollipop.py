"""show_lollipop tests, with a fake Virtual Lab client."""
import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "lambda"))
from tool_show_lollipop import show_lollipop  # noqa: E402
from virtual_lab_client import ClientError  # noqa: E402

RACE_BLACK = {"and": [{"in": {"demographic.race": ["black or african american"]}}]}
COVERED = [("KRAS", 148), ("NRAS", 113), ("TP53", 60), ("BRAF", 40), ("DIS3", 100), ("MYC", 30)]
GENES = {"kras": {"name": "KRAS"}, "c-myc": {"name": "MYC"}}


def skewer():
    counts = [("p.G12C", 5), ("p.Q61H", 38), ("p.G12V", 27), ("p.G12D", 23)]
    items = [{"mname": m, "occurrence": n} for m, n in counts]
    items += [{"mname": f"p.X{i}"} for i in range(10)]  # No occurrence counts as 0.
    return items


class FakeClient:
    def __init__(self, samples=148, fail=None):
        self.samples, self.fail = samples, fail
        self.looked_up = []

    def case_count(self, cohort_filter):
        if self.fail:
            raise self.fail
        return 334 if cohort_filter else 1000

    def lookup_gene(self, name):
        if self.fail:
            raise self.fail
        self.looked_up.append(name)
        return GENES.get(name.lower())

    def top_genes(self, cohort_filter, max_genes=50):
        assert cohort_filter is None
        return COVERED

    def lollipop_track(self, gene_info, cohort_filter):
        return {"sampleTotalNumber": self.samples, "skewer": skewer() if self.samples else []}


def run(gene="KRAS", client=None, **extra):
    args = {"cohortFilter": RACE_BLACK, **extra}
    if gene is not None:
        args["gene"] = gene
    return show_lollipop(args, client or FakeClient())


class ShowLollipop(unittest.TestCase):
    def test_ok_reports_samples_variants_and_top_three(self):
        r = run()
        self.assertEqual(r["status"], "ok")
        self.assertEqual((r["sampleCount"], r["variantCount"]), (148, 14))
        self.assertEqual(r["topVariants"], [{"change": "p.Q61H", "count": 38},
                                            {"change": "p.G12V", "count": 27},
                                            {"change": "p.G12D", "count": 23}])
        self.assertEqual(r["plot"], {"type": "lollipop", "gene": "KRAS"})
        self.assertEqual(r["cohort"], {"label": "Race: black or african american", "caseCount": 334})
        self.assertNotIn("coveredGenes", r)
        for n in (148, 14, 38, 27, 23, 334):
            self.assertIn(str(n), r["summary"])
        self.assertIn("148 samples", r["summary"])

    def test_alias_uses_the_resolved_name(self):
        r = run("c-Myc")
        self.assertEqual(r["gene"], "MYC")
        self.assertEqual(r["plot"]["gene"], "MYC")

    def test_gene_shaped_name_is_no_data_for_gene(self):
        r = run("BRCA1")
        self.assertEqual(r["status"], "no_data_for_gene")
        self.assertEqual(r["coveredGenes"], ["KRAS", "NRAS", "TP53", "BRAF", "DIS3", "MYC"])
        self.assertNotIn("plot", r)
        self.assertIn("KRAS", r["summary"])

    def test_no_data_wording_makes_no_claim_it_is_real(self):
        s = run("BRCA1")["summary"]
        self.assertIn("isn't in this dataset", s)
        self.assertNotIn("real gene", s)
        self.assertNotIn("valid", s)

    def test_other_text_is_unknown_gene(self):
        r = run("not a gene!")
        self.assertEqual(r["status"], "unknown_gene")
        self.assertNotIn("plot", r)

    def test_zero_samples_is_none_in_cohort(self):
        r = run(client=FakeClient(samples=0))
        self.assertEqual(r["status"], "none_in_cohort")
        self.assertEqual(r["summary"], "0 of 334 cases in this cohort have a KRAS mutation.")
        self.assertNotIn("plot", r)

    def test_no_cohort_means_all_cases(self):
        r = show_lollipop({"gene": "KRAS"}, FakeClient())
        self.assertEqual(r["cohort"], {"label": "All cases", "caseCount": 1000})

    def test_missing_gene_is_an_error(self):
        for gene in (None, "", "  ", 5):
            with self.subTest(gene=gene):
                r = run(gene) if gene != 5 else show_lollipop({"gene": 5}, FakeClient())
                self.assertEqual((r["status"], r["step"]), ("error", "invalid_input"))

    def test_client_failure_names_the_step(self):
        r = run(client=FakeClient(fail=ClientError("paint_failed", "boom")))
        self.assertEqual((r["status"], r["step"]), ("error", "paint_failed"))

    def test_no_case_or_sample_ids_in_result(self):
        for r in (run(), run("BRCA1"), run(client=FakeClient(samples=0))):
            self.assertNotIn("SYNTH-", json.dumps(r))

    def test_registered_with_the_handler(self):
        import handler
        self.assertIs(handler.CLIENT_TOOLS["show_lollipop"], show_lollipop)


if __name__ == "__main__":
    unittest.main()
