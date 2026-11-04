# Spec Delta

## Purpose

Lets the Correlation Plot tool compare overall survival between patient groups, such as CGS high-risk versus standard-risk, and return a result the Virtual Lab's existing survival plot renders.

## ADDED Requirements

### Requirement: Survival through the Correlation Plot tool
When `correlation_plot` receives overall survival as one variable and a supported grouping field as the other, in either order, it SHALL compute Kaplan-Meier overall survival with one curve per value of that field.

#### Scenario: CGS risk comparison
- **WHEN** the tool receives "overall survival" and "CGS risk" with no cohort
- **THEN** the plot has one curve for High risk and one for Standard risk, with 339 and 661 cases for the default seed

#### Scenario: Variables in either order
- **WHEN** the tool receives "CGS risk category" as primary and "survival" as secondary
- **THEN** it produces the same result as the reverse order

#### Scenario: Cohort-limited comparison
- **WHEN** the request carries a cohort filter
- **THEN** each curve counts only cases matching both the cohort and its group

### Requirement: Variable names resolve through a catalog
The tool SHALL resolve each variable name, case-insensitively, against a catalog of supported fields and their synonyms, and MUST reject a name that matches no entry or more than one, listing the supported options.

#### Scenario: Synonym
- **WHEN** a variable is named "CGS risk", "cgs risk category" or "risk group"
- **THEN** it resolves to the CGS risk category field

#### Scenario: Unknown variable
- **WHEN** a variable matches no catalog entry
- **THEN** the tool fails with a message listing supported variables and makes no data request

### Requirement: Unsupported pairs fail clearly
The tool SHALL fail with a clear "not supported yet" message for pairs that do not include overall survival, and for progression-free survival.

#### Scenario: Non-survival pair
- **WHEN** the tool receives "age at diagnosis" and "KRAS expression"
- **THEN** it fails stating that only survival comparisons are supported so far

### Requirement: Plot matches the existing survival chart
A successful survival call SHALL return `plot` with `type: "survival"`, `survivalData` and `overallStats` in the frontend's survival-plot data shape (case points with time in days, censored flag, survival estimate, case id; log-rank p-value), plus `labels`, `counts`, the resolved field, and settings to open the same comparison in the Correlation tool.

#### Scenario: Native rendering
- **WHEN** `plot.survivalData` and `plot.overallStats` are passed to the frontend's survival plot with `plot.labels` as names
- **THEN** it renders one labelled curve per group and the p-value without transformation

### Requirement: Summary for the model
A successful call SHALL return a `summary` stating each group's label and case count and the log-rank p-value, and noting that the data is synthetic. The model receives only this summary.

#### Scenario: CGS summary
- **WHEN** the CGS comparison succeeds
- **THEN** the summary names High risk (n=339) and Standard risk (n=661), the p-value, and the synthetic-data note

### Requirement: Group limits
The tool SHALL fail without a plot when any group has fewer than 10 cases or the field would produce more than 5 curves.

#### Scenario: Group too small
- **WHEN** the cohort filter leaves a group with fewer than 10 cases
- **THEN** the tool fails, naming the group and its count

### Requirement: Same behavior in process or over HTTP
The survival executor SHALL behave identically when called in the agent process or through an HTTP endpoint using the scaffold's `CORRELATION_TOOL_URL` contract.

#### Scenario: HTTP executor
- **WHEN** the agent is configured with `CORRELATION_TOOL_URL` pointing at the survival executor's endpoint
- **THEN** the CGS comparison returns the same `summary` and `plot` as the in-process executor
