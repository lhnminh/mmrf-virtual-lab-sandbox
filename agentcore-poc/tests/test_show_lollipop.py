"""show_lollipop tests, with a fake Virtual Lab client."""
import io
import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "lambda"))
from tool_show_lollipop import show_lollipop  # noqa: E402
from virtual_lab_client import ClientError, VirtualLabClient  # noqa: E402

RACE_BLACK = {"and": [{"in": {"demographic.race": ["black or african american"]}}]}
COVERED = [("KRAS", 148), ("NRAS", 113), ("TP53", 60), ("BRAF", 40), ("DIS3", 100), ("MYC", 30)]
GENES = {"kras": {"name": "KRAS"}, "c-myc": {"name": "MYC"}}
LAB_GENE = {"name": "KRAS", "chr": "chr12", "start": 25205245, "stop": 25250929}

# ProteinPaint's real mds3 reply when no sample in the cohort has a mutation in the gene.
# It has no sampleTotalNumber. Captured from the local stack; deployed fails the same way.
NO_MATCH_TRACK = {"variantAlerts": [], "skewer": [], "cnv": {"cnvs": []}, "mclass2variantcount": []}


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


class ReplyOpener:
    def __init__(self, reply):
        self.reply = reply

    def open(self, request, timeout=None):
        return io.BytesIO(json.dumps(self.reply).encode())


class TrackClient(FakeClient):
    """Sends a raw mds3 reply through the real client's lollipop_track."""

    def __init__(self, reply):
        super().__init__()
        self.lab = VirtualLabClient("https://lab.example", {"username": "u", "password": "p"},
                                    opener=ReplyOpener(reply))

    def lookup_gene(self, name):
        return LAB_GENE

    def lollipop_track(self, gene_info, cohort_filter):
        return self.lab.lollipop_track(gene_info, cohort_filter)


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

    def test_live_reply_with_no_matching_sample_is_none_in_cohort(self):
        r = run(client=TrackClient(NO_MATCH_TRACK))
        self.assertEqual(r["status"], "none_in_cohort")
        self.assertEqual(r["summary"], "0 of 334 cases in this cohort have a KRAS mutation.")
        self.assertEqual(r["cohort"], {"label": "Race: black or african american", "caseCount": 334})
        self.assertNotIn("plot", r)

    def test_an_explicit_zero_with_no_variants_is_none_in_cohort(self):
        r = run(client=TrackClient({"sampleTotalNumber": 0, "skewer": []}))
        self.assertEqual(r["status"], "none_in_cohort")

    def test_a_real_track_still_reports_its_samples(self):
        track = {"sampleTotalNumber": 2, "skewer": [{"mname": "p.G12D", "occurrence": 2}]}
        r = run(client=TrackClient(track))
        self.assertEqual((r["status"], r["sampleCount"]), ("ok", 2))

    def test_any_other_malformed_track_is_an_error(self):
        variant = {"mname": "p.G12D", "occurrence": 2}
        for name, reply in (("variants without a total", {"skewer": [variant]}),
                            ("no skewer or total", {"variantAlerts": []}),
                            ("no skewer, zero total", {"sampleTotalNumber": 0}),
                            ("skewer isn't a list", {"skewer": {}}),
                            ("null skewer", {"skewer": None}),
                            ("null total", {"sampleTotalNumber": None, "skewer": []}),
                            ("text total", {"sampleTotalNumber": "2", "skewer": [variant]}),
                            ("true total", {"sampleTotalNumber": True, "skewer": [variant]}),
                            ("negative total", {"sampleTotalNumber": -1, "skewer": [variant]}),
                            ("zero total with variants", {"sampleTotalNumber": 0, "skewer": [variant]}),
                            ("samples without variants", {"sampleTotalNumber": 2, "skewer": []})):
            with self.subTest(name):
                r = run(client=TrackClient(reply))
                self.assertEqual((r["status"], r["step"]), ("error", "unhealthy"))

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
