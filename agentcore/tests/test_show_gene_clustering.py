"""show_gene_clustering tests, with a fake Virtual Lab client."""
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "lambda"))
from tool_show_gene_clustering import MAX_SET_GENES, show_gene_clustering  # noqa: E402
from virtual_lab_client import ClientError  # noqa: E402

RACE_BLACK = {"and": [{"in": {"demographic.race": ["black or african american"]}}]}
GENES = [f"GENE{number}" for number in range(1, 21)]
SET_GENES = ["DUSP4", "ETV5", "SPRY2"]


class FakeClient:
    def __init__(self, genes=GENES, cases=334, count_error=None, genes_error=None, has_sets=True,
                 found=("HALLMARK_HYPOXIA",), set_genes=SET_GENES, find_error=None):
        self.genes, self.cases = genes, cases
        self.count_error, self.genes_error = count_error, genes_error
        self.has_sets, self.found, self.set_genes, self.find_error = has_sets, list(found), set_genes, find_error
        self.top_calls, self.find_calls, self.set_calls = [], [], []
        self.availability_checks = 0

    def case_count(self, cohort_filter):
        if self.count_error:
            raise self.count_error
        return self.cases

    def top_variable_genes(self, cohort_filter, max_genes):
        self.top_calls.append((cohort_filter, max_genes))
        if self.genes_error:
            raise self.genes_error
        return self.genes

    def has_gene_sets(self):
        self.availability_checks += 1
        return self.has_sets

    def find_gene_sets(self, text):
        self.find_calls.append(text)
        if self.find_error:
            raise self.find_error
        return self.found

    def gene_set_genes(self, term_id):
        self.set_calls.append(term_id)
        return self.set_genes


def run(client=None, **args):
    return show_gene_clustering({"cohortFilter": RACE_BLACK, **args}, client or FakeClient())


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


class NamedGeneSet(unittest.TestCase):
    def test_mek_shortcut_uses_the_up_set_and_names_the_other(self):
        for name in ("MEK", "mek", " MEK pathway ", "MEK gene set", "mek signature", "MEK set"):
            with self.subTest(name=name):
                client = FakeClient()
                r = run(client, geneSet=name)
                self.assertEqual(r["status"], "ok")
                self.assertEqual(r["geneSet"], {"id": "MEK_UP.V1_UP", "geneCount": 3})
                self.assertEqual(r["plot"], {"type": "gene_clustering", "genes": SET_GENES})
                self.assertEqual(client.find_calls, [])
                self.assertEqual(client.set_calls, ["MEK_UP.V1_UP"])
                self.assertIn("MEK_UP.V1_UP, chosen for MEK", r["summary"])
                self.assertIn("MEK_UP.V1_DN is also available", r["summary"])
                self.assertIn("lists 3 genes", r["summary"])
                self.assertIn("only those with expression data", r["summary"])
                self.assertIn("red means high relative to the other samples", r["summary"])
                self.assertNotIn(SET_GENES[0], r["summary"])

    def test_without_a_set_the_top_20_is_unchanged(self):
        client = FakeClient()
        r = run(client)
        self.assertEqual(r["plot"], {"type": "gene_clustering", "maxGenes": 20})
        self.assertEqual(client.availability_checks, 0)
        self.assertEqual(client.find_calls, [])
        self.assertNotIn("geneSet", r)

    def test_a_blank_name_means_no_set(self):
        client = FakeClient()
        self.assertEqual(run(client, geneSet="  ")["plot"], {"type": "gene_clustering", "maxGenes": 20})
        self.assertEqual(client.availability_checks, 0)

    def test_one_search_result_is_used(self):
        client = FakeClient()
        r = run(client, geneSet="HALLMARK_HYPOXIA")
        self.assertEqual(r["status"], "ok")
        self.assertEqual(client.find_calls, ["HALLMARK_HYPOXIA"])
        self.assertEqual(r["geneSet"]["id"], "HALLMARK_HYPOXIA")
        self.assertNotIn("chosen for", r["summary"])
        self.assertNotIn("also available", r["summary"])

    def test_the_other_mek_set_can_be_asked_for_by_id(self):
        r = run(FakeClient(found=["MEK_UP.V1_DN"]), geneSet="MEK_UP.V1_DN")
        self.assertEqual(r["geneSet"]["id"], "MEK_UP.V1_DN")
        self.assertNotIn("chosen for", r["summary"])

    def test_an_exact_id_wins_in_any_case(self):
        r = run(FakeClient(found=["HALLMARK_HYPOXIA", "HALLMARK_HYPOXIA_DN"]), geneSet="hallmark_hypoxia")
        self.assertEqual(r["geneSet"]["id"], "HALLMARK_HYPOXIA")

    def test_several_results_are_ambiguous(self):
        found = [f"SET_{number}" for number in range(7)]
        client = FakeClient(found=found)
        r = run(client, geneSet="hypoxia")
        self.assertEqual(r["status"], "ambiguous")
        self.assertEqual(r["options"], found[:5])
        self.assertEqual(r["matchCount"], 7)
        self.assertIn("7 MSigDB sets", r["summary"])
        self.assertEqual(client.set_calls, [])
        self.assertNotIn("plot", r)

    def test_no_result_is_not_found(self):
        client = FakeClient(found=[])
        r = run(client, geneSet="MEK and hypoxia")
        self.assertEqual(r["status"], "gene_set_not_found")
        self.assertIn("MEK and hypoxia", r["summary"])
        self.assertEqual(client.set_calls, [])
        self.assertNotIn("plot", r)

    def test_no_msigdb_is_unavailable(self):
        client = FakeClient(has_sets=False)
        r = run(client, geneSet="MEK")
        self.assertEqual(r["status"], "prebuilt_unavailable")
        self.assertIn("top 20", r["summary"])
        self.assertEqual((client.find_calls, client.set_calls), ([], []))
        self.assertNotIn("plot", r)

    def test_availability_is_checked_on_each_call(self):
        client = FakeClient()
        run(client, geneSet="MEK")
        run(client, geneSet="MEK")
        self.assertEqual(client.availability_checks, 2)

    def test_a_large_set_is_refused(self):
        r = run(FakeClient(set_genes=[f"G{n}" for n in range(MAX_SET_GENES + 1)]), geneSet="HALLMARK_HYPOXIA")
        self.assertEqual(r["status"], "gene_set_too_large")
        self.assertIn(str(MAX_SET_GENES + 1), r["summary"])
        self.assertNotIn("plot", r)

    def test_a_set_at_the_limit_is_drawn(self):
        r = run(FakeClient(set_genes=[f"G{n}" for n in range(MAX_SET_GENES)]), geneSet="HALLMARK_HYPOXIA")
        self.assertEqual(r["status"], "ok")

    def test_an_empty_set_is_no_data(self):
        r = run(FakeClient(set_genes=[]), geneSet="HALLMARK_HYPOXIA")
        self.assertEqual(r["status"], "no_data")
        self.assertNotIn("plot", r)

    def test_no_cases_comes_first(self):
        client = FakeClient(cases=0)
        r = run(client, geneSet="MEK")
        self.assertEqual(r["status"], "no_cases")
        self.assertEqual((client.availability_checks, client.set_calls), (0, []))

    def test_a_non_text_name_is_invalid(self):
        client = FakeClient()
        r = run(client, geneSet=5)
        self.assertEqual((r["status"], r["step"]), ("error", "invalid_input"))
        self.assertEqual(client.top_calls, [])

    def test_a_failed_search_is_a_failure(self):
        r = run(FakeClient(find_error=ClientError("unhealthy", "x")), geneSet="hypoxia")
        self.assertEqual((r["status"], r["step"]), ("error", "unhealthy"))
        self.assertNotIn("plot", r)


if __name__ == "__main__":
    unittest.main()
