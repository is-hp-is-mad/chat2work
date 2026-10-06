---
name: research
description: Run a thorough web research task and produce a sourced written answer — market scans, competitor comparisons, technical evaluations, "find out everything about X". Use when the question needs more than one page of reading.
version: 1.0.0
---

# Research

Shallow research reads one page and paraphrases it. Useful research reads
several, notices where they disagree, and says which claim rests on what.

## Method

1. **Decompose the question.** Write down the three to six sub-questions that
   together answer it. Put them in `TodoWrite` so the user can see the shape of
   the work.

2. **Search broadly, then narrowly.** Run `WebSearch` several different ways —
   by entity name, by the problem it solves, by the term a critic would use.
   One phrasing surfaces one cluster of sources.

3. **Read the primary source.** `WebFetch` the actual documentation, filing,
   paper or repository. Secondary coverage drifts; treat a news article as a
   pointer to the primary source, not as the source.

4. **Record as you go.** Keep notes in the active space
   (`research-notes.md`), one section per sub-question, each claim followed by
   the URL it came from. Do not hold twenty pages in your head and write at the
   end — you will lose the attributions.

5. **Look for the disagreement.** If every source says the same thing in the
   same words, you have found one source repeated. Search specifically for
   criticism, limitations, or "problems with X".

6. **Write the answer.** Lead with the conclusion. Then the evidence. Then what
   you could not establish.

## What the output should contain

- **The answer, first.** Two or three sentences before any detail.
- **Evidence with links.** Inline `[label](url)` after each substantive claim.
- **Dates.** "As of the March 2026 filing…" — research goes stale, and the
  reader needs to know how stale.
- **Confidence, stated honestly.** Separate what multiple independent sources
  confirm from what one blog asserts.
- **What you could not find.** An explicit "I could not establish X" is more
  useful than an implied answer.

## Anti-patterns

- Citing a URL you did not actually fetch.
- Presenting a vendor's own marketing page as an evaluation of the vendor.
- Burying the conclusion under a summary of your own process.
- Padding with background the user already has.

## Deliverable

Write the report to the active space as Markdown, and offer a `.docx` or `.pdf`
version via the `docx` / `pdf` skills if the user will be sharing it.
