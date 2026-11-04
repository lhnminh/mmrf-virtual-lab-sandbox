# User journeys and success criteria

From the ORION hackathon brief (Vision document, Workstream 2: Agent
Orchestration). Copied here so everyone, and every Claude session, can read
them. The results come from synthetic data and have no clinical meaning.

## Objective

Build an agent-powered natural-language interface within Virtual Lab that helps
researchers use its existing capabilities through conversation. If a question
does not name a tool, the agent should select the most appropriate existing
Virtual Lab tools and display their interactive visualizations within the
conversation.

In scope: one or more agents hosted on Amazon Bedrock AgentCore; a simple flow
of question in, plan, tool calls, answer out; a conversational interface
embedded in the existing frontend, with cohort selections and analysis context
consistent with the rest of the platform.

Out of scope: live production services, private patient data, production
credentials, long-term memory, full auth and scale testing.

## Journeys

Each journey has a version that names the tools and an open-ended version.
Both should lead to the same analysis.

| # | Names the tools | Open-ended | Status |
| --- | --- | --- | --- |
| 1 | Using the Correlation Plot tool, please perform Kaplan Meyer survival analysis to overlay outcomes of patients diagnosed with CGS high-risk versus CGS standard-risk disease. | Please perform survival analysis to compare outcomes of patients diagnosed with CGS high-risk versus CGS standard-risk disease. | Works locally (`correlation_plot`) |
| 2 | Using the cohort builder tool, create a cohort of Black or African American patients and then use the Oncomatrix tool to display the top 3 most frequently mutated genes within these myeloma patients. | Display the top 3 most frequently mutated genes in Black or African American multiple myeloma patients | Tool verified locally; Chat now offers the interactive OncoMatrix, pending frontend build check |
| 3 | Using the Gen3 Analysis API, retrieve KRAS-mutated case IDs with POST /analysis/v0/genomic/gene_cases and mutation-tested case IDs with POST /analysis/v0/cases/. Save cohorts with and without detected KRAS mutations, then select them in the Differential Expression Analysis Tool to identify the top 10 differentially expressed genes. | Perform differential gene expression analysis between patients with and without a KRAS gene mutation and display the top 10 differentially expressed genes. | Not started |

## Expected outcomes

- **Survival by risk category**: the agent selects CGS high-risk and CGS
  standard-risk cohorts, runs the comparison in the appropriate platform tool,
  and displays the overlaid survival curves with group labels, case counts and
  available statistics. Synthetic result: High risk 339 cases, Standard risk
  661, log-rank p = 7.1e-60.
- **Frequently mutated genes**: the agent creates the requested demographic
  cohort, identifies its three most frequently mutated genes, and displays them
  for the selected cohort in OncoMatrix. The answer includes the cohort size and
  the counts used to rank the genes. Synthetic result: 334 cases; KRAS 148,
  NRAS 113, DIS3 100.
- **Differential expression by KRAS status**: the agent forms cohorts with and
  without a KRAS mutation, uses the Differential Expression Analysis Tool, and
  displays the ten leading genes with the ranking method, group sizes and
  available effect-size and significance measures. It checks that the selected
  cases have the data needed for the comparison.

For each journey, the researcher can see the plan, selected tools, relevant
settings, results and existing interactive platform visualizations within the
conversation. If a tool or required data is unavailable, the agent reports the
limitation instead of inventing results.

## Success looks like

- Agents running on AgentCore enable users to operate Virtual Lab through a
  conversational interface, displaying relevant results and visualizations.
- The user can see the plan and the tool calls, not just the final answer.
- The answer keeps observations and interpretation clearly separate.
- When the tool result is insufficient, the agent says so instead of guessing.
