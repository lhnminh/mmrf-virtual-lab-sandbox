"""show_gene_clustering: names the top variable genes. The browser clusters and draws the heatmap."""
import logging

from cohort_filter import label
from results import failure, ok, outcome
from virtual_lab_client import ClientError

logger = logging.getLogger(__name__)

TOP_GENES = 20


def _cases(number):
    return f"{number} {'case' if number == 1 else 'cases'}"


def _listing(genes):
    return genes[0] if len(genes) == 1 else f"{', '.join(genes[:-1])} and {genes[-1]}"


def show_gene_clustering(args, client):
    cohort_filter = args.get("cohortFilter") or None
    try:
        case_count = client.case_count(cohort_filter)
        cohort = {"label": label(cohort_filter), "caseCount": case_count}
        if case_count == 0:
            return outcome("no_cases", "This cohort has no cases, so there's no heatmap.", cohort=cohort)
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
              f"{_listing(genes)}. The clustering is on the chart, and red means high relative to the other samples.",
              cohort=cohort, genes=genes, plot={"type": "gene_clustering", "maxGenes": TOP_GENES})
