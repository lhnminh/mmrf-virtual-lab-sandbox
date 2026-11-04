"""Reads numbers from the Virtual Lab's own services. Errors never hold the login."""
import base64
import json
import re
import urllib.error
import urllib.request

HTTP_TIMEOUT_SECONDS = 20
_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_GENOME = {"genome": "hg38", "dslabel": "MMRF"}


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

    def _post(self, path, body):
        request = urllib.request.Request(
            self._origin + path, data=json.dumps(body).encode(), headers=self._headers, method="POST")
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

    def _guppy(self, query, cohort_filter):
        body = self._post("/guppy/graphql", {"query": query, "variables": {"f": cohort_filter}})
        if not isinstance(body, dict) or body.get("errors") or not isinstance(body.get("data"), dict):
            raise ClientError("unhealthy", "The Virtual Lab data query failed.")
        return body["data"]["Case__aggregation"]["case"]

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

    def lookup_gene(self, name):
        reply = self._paint("genelookup", {"input": name, "deep": 1})
        matches = reply.get("gmlst")
        return matches[0] if matches else None

    @staticmethod
    def _region(gene_info):
        return [{"chr": gene_info["chr"], "start": gene_info["start"],
                 "stop": gene_info["stop"], "width": 800}]

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
        if "sampleTotalNumber" not in reply or not isinstance(reply.get("skewer"), list):
            raise ClientError("unhealthy", "The lollipop data was missing.")
        return {"sampleTotalNumber": reply["sampleTotalNumber"], "skewer": reply["skewer"]}
