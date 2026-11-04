"""show_gene_clustering: finds the genes for a heatmap. The browser clusters and draws it."""
import logging

from cohort_filter import label
from results import failure, ok, outcome
from virtual_lab_client import ClientError

logger = logging.getLogger(__name__)

TOP_GENES = 20
MAX_SET_GENES = 500  # The upper cutoff the MSigDB config uses for gene set analysis.
MAX_OPTIONS = 5
MEK_SET = "MEK_UP.V1_UP"
OTHER_MEK_SET = "MEK_UP.V1_DN"
# Both MEK sets match "MEK". The user chose this default, and the answer names the other one.
MEK_NAMES = {"mek", "mek pathway", "mek gene set", "mek geneset", "mek set", "mek signature"}
CLUSTERING_NOTE = "The clustering is on the chart, and red means high relative to the other samples."


def _cases(number):
    return f"{number} {'case' if number == 1 else 'cases'}"


def _listing(genes):
    return genes[0] if len(genes) == 1 else f"{', '.join(genes[:-1])} and {genes[-1]}"


def _matching_set(name, found):
    """The set to draw: an exact ID wins, otherwise the only result. None if that's not decided."""
    for term_id in found:
        if term_id.lower() == name.lower():
            return term_id
    return found[0] if len(found) == 1 else None


def _gene_set_result(name, case_count, cohort, client):
    if not client.has_gene_sets():
        return outcome("prebuilt_unavailable", "Prebuilt gene sets aren't available on this Virtual Lab. "
                                               "The top 20 variably expressed genes can be used instead.", cohort=cohort)
    is_shortcut = name.lower() in MEK_NAMES
    if is_shortcut:
        term_id = MEK_SET
    else:
        found = client.find_gene_sets(name)
        if not found:
            return outcome("gene_set_not_found", f"No MSigDB gene set matches '{name}'.", cohort=cohort)
        term_id = _matching_set(name, found)
        if term_id is None:
            options = found[:MAX_OPTIONS]
            return outcome("ambiguous", f"{len(found)} MSigDB sets match '{name}'. Some of them: {_listing(options)}.",
                           options=options, matchCount=len(found), cohort=cohort)
    genes = client.gene_set_genes(term_id)
    if not genes:
        return outcome("no_data", f"The MSigDB set {term_id} lists no genes, so there's no heatmap.", cohort=cohort)
    if len(genes) > MAX_SET_GENES:
        return outcome("gene_set_too_large", f"The MSigDB set {term_id} lists {len(genes)} genes, which is more than "
                                             f"the {MAX_SET_GENES} that can be drawn here, so there's no heatmap.",
                       cohort=cohort)
    chosen = f", chosen for MEK. {OTHER_MEK_SET} is also available" if is_shortcut else ""
    return ok(f"{_cases(case_count)}. Gene expression heatmap of the MSigDB set {term_id}{chosen}. The set lists "
              f"{len(genes)} genes, and the heatmap draws only those with expression data, so the chart shows how many. "
              f"{CLUSTERING_NOTE}", cohort=cohort, geneSet={"id": term_id, "geneCount": len(genes)},
              plot={"type": "gene_clustering", "genes": genes})


def show_gene_clustering(args, client):
    asked = args.get("geneSet")
    if asked is not None and not isinstance(asked, str):
        return failure("invalid_input", "geneSet must be text, such as MEK.")
    name = (asked or "").strip()
    cohort_filter = args.get("cohortFilter") or None
    try:
        case_count = client.case_count(cohort_filter)
        cohort = {"label": label(cohort_filter), "caseCount": case_count}
        if case_count == 0:
            return outcome("no_cases", "This cohort has no cases, so there's no heatmap.", cohort=cohort)
        if name:
            return _gene_set_result(name, case_count, cohort, client)
        genes = client.top_variable_genes(cohort_filter, TOP_GENES)
    except ClientError as error:
        logger.error("Virtual Lab call failed at %s", error.step)
        if error.step == "too_few_samples":
            return outcome("too_few_samples",
                           f"Ranking genes needs at least 10 samples with expression data, and this cohort of "
                           f"{_cases(case_count)} has fewer, so there's no heatmap.", cohort=cohort)
        return failure(error.step, str(error))
    if not genes:
        return outcome("no_data", f"The {_cases(case_count)} in this cohort have no gene expression data, "
                                  "so there's no heatmap.", cohort=cohort)
    return ok(f"{_cases(case_count)}. Gene expression heatmap of the top {len(genes)} variably expressed genes: "
              f"{_listing(genes)}. {CLUSTERING_NOTE}",
              cohort=cohort, genes=genes, plot={"type": "gene_clustering", "maxGenes": TOP_GENES})
