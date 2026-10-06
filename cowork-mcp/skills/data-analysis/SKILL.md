---
name: data-analysis
description: Analyse a CSV, Excel, JSON or database extract and report what it actually says — cleaning, aggregation, trends, outliers, and charts. Use whenever the user hands over data and asks a question about it.
version: 1.0.0
requires: pandas, matplotlib
---

# Data analysis

`python <skill_dir>/../_shared/ensure_deps.py pandas matplotlib`

Use the `REPL` tool, not one-shot Bash scripts. The interpreter keeps the
dataframe loaded between calls, so you can look, adjust, and look again without
re-reading a large file each time.

## Always start by looking

Never aggregate data you have not inspected. The first call should be:

```python
import pandas as pd
df = pd.read_csv(path)
print(df.shape)
print(df.dtypes)
print(df.head(10))
print(df.isna().sum())
print(df.describe(include="all").T)
```

Then check the things that quietly wreck an analysis:

- **Duplicate rows** — `df.duplicated().sum()`
- **Dates stored as strings** — `pd.to_datetime(df["date"], errors="coerce")`,
  then count how many became `NaT`
- **Numbers stored as strings** — currency symbols, thousands separators,
  `"1,234"`, `"(500)"` for negatives
- **Mixed categories** — `df["region"].value_counts()` reveals `"US"`, `"us"`
  and `"U.S."` as three regions
- **Sentinel values** — `-1`, `999`, `0` standing in for missing

Report what you cleaned. A number that changed because you dropped 8% of rows
is a different number.

## Answer the question that was asked

Compute the specific thing, then check whether it is robust:

- Does the trend hold when you exclude the largest contributor?
- Is the difference between groups larger than the variation within them?
- How many rows underlie the smallest group? A 40% rate on 5 rows is noise.

State the caveat next to the number, not in a footnote.

## Charts

```python
import matplotlib
matplotlib.use("Agg")            # no display in this environment
import matplotlib.pyplot as plt

fig, ax = plt.subplots(figsize=(9, 5), dpi=160)
ax.plot(monthly.index, monthly.values, linewidth=2)
ax.set_title("Monthly revenue")
ax.set_ylabel("USD")
ax.grid(alpha=0.3)
ax.spines[["top", "right"]].set_visible(False)
fig.tight_layout()
fig.savefig(out_png)
plt.close(fig)
```

Then `Read` the PNG to check it before showing it to the user — mislabelled
axes and overlapping tick labels are only visible when you look.

Chart choice: lines for time, bars for comparison across categories, scatter
for the relationship between two variables, histogram for a distribution. Do
not use a pie chart for more than three slices.

## Reporting

Lead with the answer in plain language and the number that supports it. Then
the method, briefly. Then the caveats. Save the cleaned dataset and any charts
into the active space so the user can check your work.
