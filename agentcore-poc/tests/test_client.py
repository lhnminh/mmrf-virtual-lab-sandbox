"""Virtual Lab client and result contract tests, with a fake opener."""
import io
import json
import pathlib
import sys
import unittest
import urllib.error

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "lambda"))
import results  # noqa: E402
import virtual_lab_client as client_module  # noqa: E402
from virtual_lab_client import ClientError, VirtualLabClient  # noqa: E402

PASSWORD = "s3cret-password-value-1234567890"
LOGIN = {"username": "team", "password": PASSWORD}
COHORT = {"in": {"demographic.race": ["black or african american"]}}
GENE = {"name": "KRAS", "chr": "chr12", "start": 25205245, "stop": 25250929}

# Working Guppy query for field_values, found against the local stack: a dotted field is
# written as nested selections, and the histogram sits inside the innermost one.
FIELD_VALUES_QUERY = (
    "query($f:JSON){Case__aggregation{case(filter:$f,accessibility:all)"
    "{demographic{race{histogram{key count}}}}}}"
)


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


class FakeOpener:
    def __init__(self, reply=None, error=None):
        self.reply = reply
        self.error = error
        self.requests = []
        self.timeouts = []

    def open(self, request, timeout=None):
        self.requests.append(request)
        self.timeouts.append(timeout)
        if self.error:
            raise self.error
        return FakeResponse(json.dumps(self.reply).encode())

    @property
    def last(self):
        request = self.requests[-1]
        body = json.loads(request.data) if request.data else None
        return request.full_url, body


def make(reply=None, error=None):
    opener = FakeOpener(reply, error)
    return VirtualLabClient("https://lab.example", LOGIN, opener=opener), opener


class Results(unittest.TestCase):
    def test_ok_and_outcome_carry_status_summary_and_fields(self):
        self.assertEqual(results.ok("done", cases=3), {"status": "ok", "summary": "done", "cases": 3})
        self.assertEqual(results.outcome("partial", "some", n=1),
                         {"status": "partial", "summary": "some", "n": 1})

    def test_failure_sets_error_and_step(self):
        self.assertEqual(results.failure("unreachable", "no route"),
                         {"status": "error", "step": "unreachable", "summary": "no route"})


class Queries(unittest.TestCase):
    def test_case_count_query(self):
        client, opener = make({"data": {"Case__aggregation": {"case": {"_totalCount": 334}}}})
        self.assertEqual(client.case_count(COHORT), 334)
        url, body = opener.last
        self.assertEqual(url, "https://lab.example/guppy/graphql")
        self.assertIn("_totalCount", body["query"])
        self.assertEqual(body["variables"], {"f": COHORT})
        self.assertEqual(opener.timeouts[-1], 20)

    def test_case_count_without_cohort(self):
        client, opener = make({"data": {"Case__aggregation": {"case": {"_totalCount": 1000}}}})
        self.assertEqual(client.case_count(None), 1000)
        self.assertEqual(opener.last[1]["variables"], {"f": None})

    def test_top_genes_sends_filter0_and_dslabel_MMRF(self):
        reply = {"genes": [{"gene": "DIS3", "mutationStat": [{"count": 98}]},
                           {"gene": "BRAF", "mutationStat": [{"count": 76}]}]}
        client, opener = make(reply)
        self.assertEqual(client.top_genes(COHORT, 2), [("DIS3", 98), ("BRAF", 76)])
        url, body = opener.last
        self.assertEqual(url, "https://lab.example/protein-paint/termdb/topMutatedGenes")
        self.assertEqual(body["dslabel"], "MMRF")
        self.assertEqual(body["genome"], "hg38")
        self.assertEqual(body["filter0"], COHORT)
        self.assertEqual(body["maxGenes"], 2)

    def test_top_genes_omits_filter0_without_cohort(self):
        client, opener = make({"genes": []})
        client.top_genes(None)
        self.assertNotIn("filter0", opener.last[1])

    def test_lookup_gene_empty_is_none(self):
        client, opener = make({"gmlst": []})
        self.assertIsNone(client.lookup_gene("BRCA1"))
        url, body = opener.last
        self.assertEqual(url, "https://lab.example/protein-paint/genelookup")
        self.assertEqual(body["input"], "BRCA1")
        self.assertEqual(body["deep"], 1)

    def test_lookup_gene_returns_first_match(self):
        client, _ = make({"gmlst": [GENE, {"name": "other"}]})
        self.assertEqual(client.lookup_gene("KRAS"), GENE)

    def test_lollipop_uses_forTrack_and_skewer(self):
        track = {"sampleTotalNumber": 282, "skewer": [{"mname": "G12D", "occurrence": 40}], "x": 1}
        client, opener = make(track)
        result = client.lollipop_track(GENE, COHORT)
        self.assertEqual(result["sampleTotalNumber"], 282)
        self.assertEqual(result["skewer"], track["skewer"])
        url, body = opener.last
        self.assertEqual(url, "https://lab.example/protein-paint/mds3")
        self.assertEqual(body["forTrack"], 1)
        self.assertEqual(body["skewer"], 1)
        self.assertEqual(body["filter0"], COHORT)
        self.assertEqual(body["rglst"], [{"chr": "chr12", "start": 25205245, "stop": 25250929, "width": 800}])

    def test_sample_ids_uses_variant2samples(self):
        reply = {"variant2samples": {"samples": [{"sample_id": "a"}, {"sample_id": "b"}, {"sample_id": "a"}]}}
        client, opener = make(reply)
        self.assertEqual(client.sample_ids(GENE, COHORT), {"a", "b"})
        body = opener.last[1]
        self.assertEqual(body["variant2samples"], 1)
        self.assertEqual(body["get"], "samples")
        self.assertEqual(body["filter0"], COHORT)

    def test_field_values_reads_histogram(self):
        reply = {"data": {"Case__aggregation": {"case": {"demographic": {"race": {"histogram": [
            {"key": "white", "count": 334}, {"key": "asian", "count": 332}]}}}}}}
        client, opener = make(reply)
        self.assertEqual(client.field_values("demographic.race", COHORT),
                         [("white", 334), ("asian", 332)])
        self.assertEqual(opener.last[1]["query"], FIELD_VALUES_QUERY)
        self.assertEqual(opener.last[1]["variables"], {"f": COHORT})

    def test_field_values_with_a_flat_field(self):
        reply = {"data": {"Case__aggregation": {"case": {"gender": {"histogram": []}}}}}
        client, opener = make(reply)
        self.assertEqual(client.field_values("gender"), [])
        self.assertIn("{gender{histogram{key count}}}", opener.last[1]["query"])

    def test_field_values_rejects_a_field_that_isnt_a_name(self):
        client, opener = make({})
        with self.assertRaises(ClientError):
            client.field_values("a{b}")
        self.assertEqual(opener.requests, [])

    def test_sends_basic_auth(self):
        client, opener = make({"gmlst": []})
        client.lookup_gene("KRAS")
        self.assertTrue(opener.requests[-1].get_header("Authorization").startswith("Basic "))


class Errors(unittest.TestCase):
    def test_http_error_raises_client_error_with_step(self):
        for code, step in ((401, "auth_failed"), (503, "unreachable"), (404, "unreachable")):
            with self.subTest(code=code):
                client, _ = make(error=urllib.error.HTTPError("https://x", code, "bad", {}, None))
                with self.assertRaises(ClientError) as caught:
                    client.case_count(None)
                self.assertEqual(caught.exception.step, step)

    def test_network_error_and_timeout_are_unreachable(self):
        for error in (urllib.error.URLError("refused"), TimeoutError("slow")):
            with self.subTest(error=type(error).__name__):
                client, _ = make(error=error)
                with self.assertRaises(ClientError) as caught:
                    client.case_count(None)
                self.assertEqual(caught.exception.step, "unreachable")

    def test_bad_body_is_unhealthy(self):
        client, _ = make({"unexpected": True})
        with self.assertRaises(ClientError) as caught:
            client.case_count(None)
        self.assertEqual(caught.exception.step, "unhealthy")

    def test_malformed_data_is_unhealthy_for_every_guppy_call(self):
        for reply in ({"data": {}}, {"data": {"Case__aggregation": None}},
                      {"data": {"Case__aggregation": {}}}, {"data": {"Case__aggregation": {"case": None}}}):
            for call in (lambda c: c.case_count(None), lambda c: c.field_values("demographic.race")):
                with self.subTest(reply=reply):
                    client, _ = make(reply)
                    with self.assertRaises(ClientError) as caught:
                        call(client)
                    self.assertEqual(caught.exception.step, "unhealthy")

    def test_gene_without_a_region_is_unhealthy(self):
        for gene in ({"name": "KRAS"}, {"chr": "chr12", "start": 1}, {}):
            for call in (lambda c, g: c.sample_ids(g, None), lambda c, g: c.lollipop_track(g, None)):
                with self.subTest(gene=gene):
                    client, opener = make({})
                    with self.assertRaises(ClientError) as caught:
                        call(client, gene)
                    self.assertEqual(caught.exception.step, "unhealthy")
                    self.assertEqual(opener.requests, [])

    def test_graphql_errors_are_unhealthy(self):
        client, _ = make({"errors": [{"message": "boom"}]})
        with self.assertRaises(ClientError) as caught:
            client.case_count(None)
        self.assertEqual(caught.exception.step, "unhealthy")

    def test_error_never_holds_password(self):
        import base64
        token = base64.b64encode(f"team:{PASSWORD}".encode()).decode()
        leaky = urllib.error.HTTPError("https://x", 500, f"Authorization: Basic {token} {PASSWORD}", {}, None)
        for error in (leaky, urllib.error.URLError(f"{PASSWORD} {token}")):
            client, _ = make(error=error)
            with self.assertRaises(ClientError) as caught:
                client.case_count(None)
            text = repr(caught.exception) + str(caught.exception) + str(caught.exception.step)
            self.assertNotIn(PASSWORD, text)
            self.assertNotIn(token, text)

    def test_module_exposes_client_error(self):
        self.assertTrue(issubclass(client_module.ClientError, Exception))


SURVIVAL_REPLY = {"keys": ["chartId", "seriesId", "time", "survival", "lower", "upper", "nevent", "ncensor", "nrisk"],
                  "case": [["", "", 0, 1, 1, 1, 0, 0, 10]]}
TERM = {"id": "overall_survival", "type": "survival"}


def survival_client(reply):
    opener = FakeOpener(reply=reply)
    return VirtualLabClient("https://lab.example", LOGIN, opener=opener), opener


class Survival(unittest.TestCase):
    def test_config_uses_get(self):
        client, opener = survival_client({"termdbConfig": {"loneTermByType": {"": {"survival": TERM}}}})
        self.assertEqual(client.survival_term(), TERM)
        request = opener.requests[0]
        self.assertEqual(request.get_method(), "GET")
        self.assertIn("/protein-paint/termdb/config?", request.full_url)
        self.assertIn("dslabel=MMRF", request.full_url)

    def test_missing_survival_term_is_unhealthy(self):
        client, _ = survival_client({"termdbConfig": {"loneTermByType": {}}})
        with self.assertRaises(ClientError) as caught:
            client.survival_term()
        self.assertEqual(caught.exception.step, "unhealthy")

    def test_comparison_term_finds_by_id(self):
        race = {"id": "race", "type": "categorical"}
        client, opener = survival_client({"lst": [{"id": "gender"}, race]})
        self.assertEqual(client.comparison_term("race"), race)
        self.assertEqual(opener.requests[0].get_method(), "GET")
        self.assertIn("/protein-paint/termdb/termchildren?", opener.requests[0].full_url)

    def test_comparison_term_not_listed_is_none(self):
        client, _ = survival_client({"lst": [{"id": "gender"}]})
        self.assertIsNone(client.comparison_term("race"))

    def test_all_cases_sends_an_empty_filter(self):
        client, opener = survival_client(SURVIVAL_REPLY)
        self.assertEqual(client.survival(TERM, None, None), SURVIVAL_REPLY)
        body = json.loads(opener.requests[0].data)
        self.assertEqual(opener.requests[0].get_method(), "POST")
        self.assertEqual(body["filter0"], {"and": []})
        self.assertEqual(body["term1"], {"$id": "survival", "term": TERM, "q": {}})
        self.assertNotIn("term2", body)

    def test_comparison_sends_the_cohort_and_term2(self):
        client, opener = survival_client(SURVIVAL_REPLY)
        client.survival(TERM, {"id": "race"}, COHORT)
        body = json.loads(opener.requests[0].data)
        self.assertEqual(body["filter0"], COHORT)
        self.assertEqual(body["term2"], {"$id": "compare", "term": {"id": "race"}, "q": {"type": "values"}})

    def test_error_field_in_reply_is_unhealthy(self):
        client, _ = survival_client({"error": "term1 is missing $id"})
        with self.assertRaises(ClientError) as caught:
            client.survival(TERM, None, None)
        self.assertEqual(caught.exception.step, "unhealthy")

    def test_missing_column_is_unhealthy(self):
        client, _ = survival_client({"keys": ["seriesId", "time", "survival", "nevent", "ncensor"], "case": []})
        with self.assertRaises(ClientError) as caught:
            client.survival(TERM, None, None)
        self.assertEqual(caught.exception.step, "unhealthy")

    def test_get_maps_a_refused_login(self):
        error = urllib.error.HTTPError("https://lab.example", 401, "no", {}, None)
        client = VirtualLabClient("https://lab.example", LOGIN, opener=FakeOpener(error=error))
        with self.assertRaises(ClientError) as caught:
            client.survival_term()
        self.assertEqual(caught.exception.step, "auth_failed")


if __name__ == "__main__":
    unittest.main()
