"""Reads numbers from the Virtual Lab's own services. Errors never hold the login."""
import base64
import json
import re
import urllib.error
import urllib.parse
import urllib.request

HTTP_TIMEOUT_SECONDS = 20
_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_GENOME = {"genome": "hg38", "dslabel": "MMRF"}
_GENE_SETS = {"dslabel": "msigdb"}
_SURVIVAL_COLUMNS = ("seriesId", "time", "survival", "nevent", "ncensor", "nrisk")


class ClientError(Exception):
    """A Virtual Lab call failed. `step` is auth_failed, unreachable or unhealthy."""

    def __init__(self, step, message):
        super().__init__(message)
        self.step = step


class VirtualLabClient:
    def __init__(self, origin, login, opener=None):
        self._origin = origin.rstrip("/")
        token = base64.b64encode(f"{login['username']}:{login['password']}".encode()).decode()
        self._headers = {"Authorization": f"Basic {token}", "Content-Type": "application/json"}
        self._opener = opener or urllib.request.build_opener()

    def _send(self, request):
        try:
            with self._opener.open(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
                raw = response.read()
        except urllib.error.HTTPError as error:
            if error.code == 401:
                raise ClientError("auth_failed", "The Virtual Lab refused the login.") from None
            raise ClientError("unreachable", f"The Virtual Lab returned HTTP {error.code}.") from None
        except OSError:  # URLError, socket errors and timeouts are all OSErrors.
            raise ClientError("unreachable", "The Virtual Lab couldn't be reached.") from None
        try:
            return json.loads(raw)
        except ValueError:
            raise ClientError("unhealthy", "The Virtual Lab sent a response that wasn't JSON.") from None

    def _post(self, path, body):
        return self._send(urllib.request.Request(
            self._origin + path, data=json.dumps(body).encode(), headers=self._headers, method="POST"))

    def _fetch(self, path, query):
        """GET a ProteinPaint route, returning whatever JSON it sends."""
        values = {name: value if isinstance(value, str) else json.dumps(value)
                  for name, value in {**_GENOME, **query}.items()}
        return self._send(urllib.request.Request(
            f"{self._origin}/protein-paint/{path}?{urllib.parse.urlencode(values)}",
            headers=self._headers, method="GET"))

    def _get(self, path, query):
        """GET a ProteinPaint route. Some, such as termdb/config, don't accept POST."""
        reply = self._fetch(path, query)
        if not isinstance(reply, dict):
            raise ClientError("unhealthy", "The Virtual Lab sent an unexpected response.")
        return reply

    def _guppy(self, query, cohort_filter):
        body = self._post("/guppy/graphql", {"query": query, "variables": {"f": cohort_filter}})
        if not isinstance(body, dict) or body.get("errors") or not isinstance(body.get("data"), dict):
            raise ClientError("unhealthy", "The Virtual Lab data query failed.")
        try:
            node = body["data"]["Case__aggregation"]["case"]
        except (KeyError, TypeError):
            raise ClientError("unhealthy", "The Virtual Lab data response was incomplete.") from None
        if not isinstance(node, dict):
            raise ClientError("unhealthy", "The Virtual Lab data response was incomplete.")
        return node

    def _paint(self, path, body, cohort_filter=None):
        payload = {**_GENOME, **body}
        if cohort_filter:
            payload["filter0"] = cohort_filter
        reply = self._post("/protein-paint/" + path, payload)
        if not isinstance(reply, dict):
            raise ClientError("unhealthy", "The Virtual Lab sent an unexpected response.")
        return reply

    def case_count(self, cohort_filter):
        query = "query($f:JSON){Case__aggregation{case(filter:$f,accessibility:all){_totalCount}}}"
        try:
            return int(self._guppy(query, cohort_filter)["_totalCount"])
        except (KeyError, TypeError, ValueError):
            raise ClientError("unhealthy", "The case count was missing.") from None

    def field_values(self, field, cohort_filter=None):
        parts = field.split(".")
        if not all(_NAME.match(part) for part in parts):
            raise ClientError("unhealthy", f"{field!r} isn't a field name.")
        selection = "".join(part + "{" for part in parts) + "histogram{key count}" + "}" * len(parts)
        query = ("query($f:JSON){Case__aggregation{case(filter:$f,accessibility:all)"
                 "{" + selection + "}}}")
        node = self._guppy(query, cohort_filter)
        try:
            for part in parts:
                node = node[part]
            return [(str(row["key"]), int(row["count"])) for row in node["histogram"]]
        except (KeyError, TypeError, ValueError):
            raise ClientError("unhealthy", "The field values were missing.") from None

    def top_genes(self, cohort_filter, max_genes=50):
        reply = self._paint("termdb/topMutatedGenes", {"maxGenes": max_genes}, cohort_filter)
        try:
            return [(g["gene"], int(g["mutationStat"][0]["count"])) for g in reply["genes"]]
        except (KeyError, IndexError, TypeError, ValueError):
            raise ClientError("unhealthy", "The ranked genes were missing.") from None

    def top_variable_genes(self, cohort_filter, max_genes):
        """The gene symbols, in the service's order. A reply's error text can hold server details, so it's not passed on."""
        query = {"maxGenes": max_genes}
        if cohort_filter:
            query["filter0"] = cohort_filter
        reply = self._get("termdb/topVariablyExpressedGenes", query)
        error = reply.get("error")
        if error:
            if "at least 10 sample" in str(error):
                raise ClientError("too_few_samples", "The cohort has too few samples to rank genes.")
            raise ClientError("unhealthy", "The gene ranking failed.")
        try:
            return [gene if isinstance(gene, str) else gene["gene"] for gene in reply["genes"]]
        except (KeyError, TypeError):
            raise ClientError("unhealthy", "The ranked genes were missing.") from None

    def has_gene_sets(self):
        """Read each time, so a stack gains prebuilt sets as soon as MSigDB is added."""
        reply = self._get("genomes", {})
        try:
            return bool((reply["genomes"]["hg38"].get("termdbs") or {}).get("msigdb"))
        except (KeyError, AttributeError, TypeError):
            raise ClientError("unhealthy", "The genome list was missing.") from None

    def find_gene_sets(self, text):
        reply = self._get("termdb", {**_GENE_SETS, "findterm": text, "targetType": "Dictionary Variables"})
        try:
            return [term["id"] for term in reply["lst"] if term.get("isleaf")]
        except (KeyError, TypeError, AttributeError):
            raise ClientError("unhealthy", "The gene set search failed.") from None

    def gene_set_genes(self, term_id):
        reply = self._fetch("termdb", {**_GENE_SETS, "genesetByTermId": term_id})
        try:
            return [gene["symbol"] for gene in reply]
        except (KeyError, TypeError):
            raise ClientError("unhealthy", "The gene set's genes were missing.") from None

    def lookup_gene(self, name):
        reply = self._paint("genelookup", {"input": name, "deep": 1})
        matches = reply.get("gmlst")
        return matches[0] if matches else None

    @staticmethod
    def _region(gene_info):
        try:
            return [{"chr": gene_info["chr"], "start": gene_info["start"],
                     "stop": gene_info["stop"], "width": 800}]
        except (KeyError, TypeError):
            raise ClientError("unhealthy", "The gene has no genomic region.") from None

    def sample_ids(self, gene_info, cohort_filter):
        reply = self._paint("mds3", {"variant2samples": 1, "get": "samples",
                                     "rglst": self._region(gene_info)}, cohort_filter)
        try:
            return {s["sample_id"] for s in reply["variant2samples"]["samples"]}
        except (KeyError, TypeError):
            raise ClientError("unhealthy", "The sample list was missing.") from None

    def lollipop_track(self, gene_info, cohort_filter):
        reply = self._paint("mds3", {"forTrack": 1, "skewer": 1,
                                     "rglst": self._region(gene_info)}, cohort_filter)
        variants = reply.get("skewer")
        # ProteinPaint omits the total when no sample in the cohort has a mutation in the gene.
        total = reply.get("sampleTotalNumber", 0 if variants == [] else None)
        if (not isinstance(variants, list) or type(total) is not int or total < 0
                or (total == 0) != (not variants)):
            raise ClientError("unhealthy", "The lollipop data was missing.")
        return {"sampleTotalNumber": total, "skewer": variants}

    def survival_term(self):
        """The dataset's own survival term, whose name may differ outside the sandbox."""
        reply = self._get("termdb/config", {"embedder": "localhost"})
        try:
            return reply["termdbConfig"]["loneTermByType"][""]["survival"]
        except (KeyError, TypeError):
            raise ClientError("unhealthy", "The dataset doesn't offer a survival term.") from None

    def comparison_term(self, term_id):
        reply = self._get("termdb/termchildren", {"filter": {"type": "tvslst", "in": True, "join": "", "lst": []}})
        terms = reply.get("lst")
        if not isinstance(terms, list):
            raise ClientError("unhealthy", "The dataset's field list was incomplete.")
        return next((term for term in terms if isinstance(term, dict) and term.get("id") == term_id), None)

    def survival(self, survival_term, compare_term, cohort_filter):
        """The curve the chart draws. The service requires $id, and answers errors with HTTP 200."""
        body = {"term1": {"$id": "survival", "term": survival_term, "q": {}}}
        if compare_term:
            body["term2"] = {"$id": "compare", "term": compare_term, "q": {"type": "values"}}
        reply = self._paint("termdb/survival", body, cohort_filter or {"and": []})
        keys = reply.get("keys")
        if reply.get("error") or not isinstance(reply.get("case"), list) or not isinstance(keys, list) \
                or any(column not in keys for column in _SURVIVAL_COLUMNS):
            raise ClientError("unhealthy", "The survival response was incomplete.")
        return reply
