"""show_gene_clustering tests, with a fake Virtual Lab client."""
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "lambda"))
from tool_show_gene_clustering import show_gene_clustering  # noqa: E402
from virtual_lab_client import ClientError  # noqa: E402

RACE_BLACK = {"and": [{"in": {"demographic.race": ["black or african american"]}}]}
GENES = [f"GENE{number}" for number in range(1, 21)]


class FakeClient:
    def __init__(self, genes=GENES, cases=334, count_error=None, genes_error=None):
        self.genes, self.cases = genes, cases
        self.count_error, self.genes_error = count_error, genes_error
        self.top_calls = []

    def case_count(self, cohort_filter):
        if self.count_error:
            raise self.count_error
        return self.cases

    def top_variable_genes(self, cohort_filter, max_genes):
        self.top_calls.append((cohort_filter, max_genes))
        if self.genes_error:
            raise self.genes_error
        return self.genes


def run(client=None):
    return show_gene_clustering({"cohortFilter": RACE_BLACK}, client or FakeClient())


class ShowGeneClustering(unittest.TestCase):
    def test_ok_reports_cases_and_all_genes(self):
        r = run()
        self.assertEqual(r["status"], "ok")
        self.assertEqual(r["genes"], GENES)
        self.assertEqual(r["cohort"], {"label": "Race: black or african american", "caseCount": 334})
        self.assertEqual(r["plot"], {"type": "gene_clustering", "maxGenes": 20})
        self.assertIn("334 cases", r["summary"])
        self.assertIn("top 20 variably expressed genes", r["summary"])
        self.assertIn("red means high relative to the other samples", r["summary"])
        for gene in GENES:
            self.assertIn(gene, r["summary"])

    def test_asks_the_service_for_20_genes(self):
        client = FakeClient()
        run(client)
        self.assertEqual(client.top_calls, [(RACE_BLACK, 20)])

    def test_fewer_genes_reports_the_real_number(self):
        r = run(FakeClient(genes=GENES[:3]))
        self.assertEqual(r["status"], "ok")
        self.assertIn("top 3 variably expressed genes", r["summary"])
        self.assertIn("GENE1, GENE2 and GENE3", r["summary"])

    def test_no_cases_skips_the_ranking(self):
        client = FakeClient(cases=0)
        r = run(client)
        self.assertEqual(r["status"], "no_cases")
        self.assertEqual(client.top_calls, [])
        self.assertNotIn("plot", r)

    def test_too_few_samples(self):
        r = run(FakeClient(cases=4, genes_error=ClientError("too_few_samples", "x")))
        self.assertEqual(r["status"], "too_few_samples")
        self.assertEqual(r["cohort"]["caseCount"], 4)
        self.assertIn("at least 10 samples", r["summary"])
        self.assertNotIn("plot", r)

    def test_no_genes_is_no_data(self):
        r = run(FakeClient(genes=[]))
        self.assertEqual(r["status"], "no_data")
        self.assertEqual(r["cohort"]["caseCount"], 334)
        self.assertNotIn("plot", r)

    def test_a_failed_call_is_a_failure(self):
        failure = ClientError("unhealthy", "x")
        for client in (FakeClient(count_error=failure), FakeClient(genes_error=failure)):
            r = run(client)
            self.assertEqual((r["status"], r["step"]), ("error", "unhealthy"))
            self.assertNotIn("plot", r)


if __name__ == "__main__":
    unittest.main()
