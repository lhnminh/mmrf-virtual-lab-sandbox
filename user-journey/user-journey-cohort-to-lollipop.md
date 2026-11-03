# User journey: from cohort to KRAS Lollipop plot, without chat

How a researcher works through the MMRF Virtual Lab today using only its existing tools. The journey builds a cohort of Black or African American patients, finds KRAS in OncoMatrix, and opens the Lollipop plot for KRAS.

**Basis:** walked through on the local synthetic sandbox (`http://localhost:3080`) on Nov 3, 2026, and checked against the MMRF Virtual Lab documentation. All counts come from that walkthrough. They are fabricated data with no clinical meaning, and production numbers will differ.

## Scenario

**User:** a translational researcher studying multiple myeloma.

**Question:** in Black or African American patients, how often is KRAS mutated, and where on the protein do those mutations fall?

**Outcome:** a Lollipop plot of KRAS limited to this cohort: 148 samples and 14 variants, with hotspots at codons 12, 13 and 61.

## Journey at a glance

The journey takes 7 clicks across 2 Virtual Lab tools, with no typing.

| # | Where | Researcher action | What they see |
| --- | --- | --- | --- |
| 1 | Header navigation | Click **Cohort Builder** | Cohort Builder opens with 1,000 cases and "No filters currently applied." |
| 2 | Cohort Builder | Click the **Demographic** tab | Demographic cards, including **Race** |
| 3 | **Race** card | Check **black or african american** (334) | Case count changes to **334 CASES**, and a RACE filter appears in the cohort filter panel |
| 4 | Header navigation | Click **Analysis Center** | Core Tools and Analysis Tools cards. The cohort stays active |
| 5 | Analysis Tools | Click the **OncoMatrix** card | Matrix of 282 samples and 6 genes, with **KRAS (148)** in the top row |
| 6 | Matrix plot | Click the **KRAS (148)** gene label | Pop-up menu with sort and move arrows, **Lollipop**, Edit, Replace and Remove |
| 7 | Gene pop-up | Click **Lollipop** | KRAS Lollipop plot opens below the matrix on the same page |

## Step by step

### 1. Build the cohort (steps 1-3)

The researcher opens **Cohort Builder** from the header. The other route is the Cohort Builder card under **Core Tools** in the Analysis Center.

Cohort Builder groups its filters into tabs: General, Demographic, Family Histories, Bone Assessment, Outcomes, Administered Regimen, General Diagnosis, CGS Risk, Biospecimen and Files. Each tab holds **cohort builder cards**, and each card is one variable.

On the **Demographic** tab, the **Race** card lists:

| Value | Cases |
| --- | --- |
| black or african american | 334 |
| white | 334 |
| asian | 332 |

Checking **black or african american** applies the filter straight away, with no Apply button. Two things update:

- The case count at the top right changes from 1,000 to **334 CASES**.
- The cohort filter panel shows a **RACE** tag with the selected value. The tag can be removed individually, or with **Clear All**.

The cohort stays active as the researcher moves between tools. It does not need to be saved for this journey.

### 2. Open OncoMatrix (steps 4-5)

The researcher returns to the **Analysis Center** and clicks **OncoMatrix** under **Analysis Tools**. The tool opens with the active cohort already applied, and the cohort filter panel stays visible above it.

The tool has three parts:

- **Control panel:** Samples, Genes, Variables, Cell Layout, Legend Layout, Download and Zoom.
- **Matrix plot:** genes as rows and samples as columns, with each cell colored by mutation class.
- **Legend panel:** mutation classes with counts, such as MISSENSE (258) and NONSENSE (8).

Genes are sorted by the number of samples with a mutation, so the most frequently mutated gene comes first:

| Gene | Samples with a mutation |
| --- | --- |
| KRAS | 148 |
| NRAS | 113 |
| DIS3 | 100 |
| MYC | 66 |
| BRAF | 52 |
| TP53 | 28 |

The header shows **334 cases** but the matrix shows **282 samples**. The difference is most likely the 52 cases with no mutation in these genes, but we did not confirm this. KRAS at 148 is 44% of the 334 cases and 52% of the 282 samples, so anyone quoting a percentage should state which denominator they used.

### 3. Select KRAS (step 6)

The researcher clicks the **KRAS (148)** gene label at the left of the top row. Hovering over the label is not enough, and clicking a cell in the row does something different (see [What the researcher can do next](#what-the-researcher-can-do-next)).

The pop-up shows:

- Arrows to sort samples against this gene, and to move the row up or down.
- A **Variable** text box for renaming the label.
- The **Lollipop** button.
- **#samples: 148 rendered, 0 not rendered**.
- **Edit**, **Replace** and **Remove**.

### 4. Open the Lollipop plot (step 7)

The researcher clicks **Lollipop**. The plot loads **below the matrix on the same page**, so both stay visible. It does not open a new page or tab, and the URL stays at `?app=OncoMatrix`.

The plot stays limited to the cohort. Its **148 samples** match the KRAS row, and the sample breakdown shows only one Race value.

The plot shows:

- **Header:** KRAS, ENSG00000133703, the hg38 genome build and the MMRF dataset, with In/Out zoom, **Tracks** and **More** buttons.
- **Left of the plot:** the **14 variants** and **148 samples** links.
- **Lollipop chart:** a disc for each variant, sized by how often it occurs and colored by mutation class.
- **Protein View:** the KRAS protein, about 189 amino acids long, with the Ras domain and Effector region marked.
- **Legend panel:** protein domains and mutation classes, which can be used to show or hide them.

| Variant | Mutation class | Samples |
| --- | --- | --- |
| p.Q61H | Missense | 38 |
| p.G12V | Missense | 27 |
| p.G12D | Missense | 23 |
| p.G13D | Missense | 15 |
| p.G12C | Missense | 9 |
| p.Q61R | Missense | 8 |
| p.F156insF | Protein insertion | 7 |
| p.Q61L | Missense | 6 |
| c.238+2T>C | Splice region | 4 |
| p.R135del | Protein deletion | 3 |
| p.K172= | Silent | 3 |
| p.V109fs | Frameshift | 2 |
| p.K117N | Missense | 2 |
| p.L56* | Nonsense | 1 |

The chart shows no number on the p.L56* disc. Its count of 1 comes from the total of 148.

## What the researcher can do next

**Tried in the walkthrough:**

| Action | Result |
| --- | --- |
| Click **148 samples** | Breakdown by Gender (male 79, female 69) and Race (one value), with "Click a category to create new track." and **List 148 samples** |
| Click **List 148 samples** | Table with Sample, Gender, Race, Mutations and Genotype. Every row shown is `black or african american` |
| Click a variant disc, such as **38** on p.Q61H | Consequence, Mutation and Occurrence, plus a table of that variant's 38 samples |

**Documented but not tried:**

- Add a Lollipop **subtrack** for one category, such as female, to compare it with the main track.
- Use **Occurrence as Y axis**, **Collapse/Expand**, **List** or **Download** from the **14 variants** link.
- Use **More** > **Export SVG** to download the plot and legend.
- Click a matrix cell to open the **Disco Plot** for that sample.
- Drag across the matrix to zoom in, list the highlighted samples or create a cohort from them.
- Add variables such as Race or Gender as extra rows at the bottom of the matrix.

## Terminology

| Informal wording | Term to use | Why |
| --- | --- | --- |
| Subset of the cohort | **Active cohort** or **current cohort** | A cohort is any set of cases defined by filters. Here it is a subset of all 1,000 cases |
| Black | Race = **black or african american** | The exact value on the Race card. It is lowercase in the UI, and the ORION Vision document writes it as "Black or African American" |
| Select KRAS mutation | Click the **KRAS gene label** | KRAS is a gene. A **mutation** or **variant** is a specific change in it, such as p.G12D |
| Lollipop | **Lollipop plot**, opened with the **Lollipop** button | The docs describe this plot under the **ProteinPaint** tool, which also has its own Analysis Tools card |
| New visual | Lollipop plot **below the matrix** | It opens in the same page, not as a new one |
| Patients | **Cases** | The Cohort Builder counts cases |
| Columns in the matrix | **Samples** | The sandbox labels them Samples, while parts of the docs say cases |
| Oncomatrix | **OncoMatrix** | The spelling on the tool card and page. The Vision document writes "Oncomatrix" |

**Abbreviations:**

- **SSM:** simple somatic mutation.
- **CNV:** copy number variation. The sandbox's KRAS plot shows "No data" for it.

## Where the sandbox differs from the docs

The docs describe production Virtual Lab, so these differences may not all apply there.

| Topic | Docs | Sandbox walkthrough |
| --- | --- | --- |
| Lollipop scope | Opening from OncoMatrix "displays all cases across" the Virtual Lab | Limited to the active cohort (148 samples, one Race value) |
| Gene pop-up | Rename, Lollipop, Gene Summary Page, Replace and Remove | Label box, Lollipop, Edit, Replace and Remove. **No Gene Summary link** |
| Control panel labels | `10000 Cases`, `50 Genes` | `282 Samples`, `6 Genes` |
| Clicking a variant disc | Opens a sunburst chart, with an Info button for the sample table | Opened the sample table directly |
| Create Cohort from the Lollipop | Checkboxes and **Create Cohort** in the sample table | **Not shown** in either table we opened from this path |

**Data differences to keep in mind:**

- **Genes:** the sandbox only has mutation data for KRAS, NRAS, TP53, BRAF, DIS3 and MYC. That is why the matrix shows 6 genes, not 50.
- **Cohort size:** Black or African American cases are about a third of the sandbox. The docs give 17% for CoMMpass.
- **Race field:** the data dictionary says race was collected for the US cohort only. The sandbox Race card has three values, while the dictionary lists more.
- **Projects:** the sandbox has `SYNTHETIC-MM` and `SYNTHETIC-RNA`. Production uses projects such as `MMRF-COMMPASS-IA24`.

## Technical notes

These are useful when reproducing the journey through an agent.

- **Routes:** `/?app=CohortBuilder` and `/?app=OncoMatrix`. The Lollipop plot has no route of its own.
- **Cohort filter field:** `demographic.race`, set in `src/features/apps/config/tabbedCohortBuilder.json`.
- **Cohort handoff:** `MatrixWrapper` reads the current cohort's filters and passes them to ProteinPaint as `filter0` (`src/features/proteinpaint/MatrixWrapper.tsx:56-59`).
- **Lollipop launch:** the button calls `launchGB`, which adds a `genomeBrowser` plot to the same ProteinPaint app with `snvindel: { shown: true }`. This code is in `@sjcrh/proteinpaint-client` 2.216.0.
- **Separate entry point:** the **ProteinPaint** card uses a different wrapper (`ProteinPaintWrapper.tsx`), which starts from a gene search box and also receives `filter0`. This route was not walked through.

## Sources

- `documents/mmrf-virtual-lab-docs/`: user guide pages for Cohort Builder, OncoMatrix and ProteinPaint, plus the CoMMpass overview and Data Dictionary v25.
- `documents/MMRF/Vision_ORION-revised.docx`: target users and the Black or African American cohort example.
- `theMMRF/mmrf-data-commons`: tool configuration and wrappers, on the `chat-core-tool` branch.
- Local sandbox walkthrough, Nov 3, 2026. The running build includes the Chat card, which this journey does not use.
