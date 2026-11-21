**The dream cycle no longer writes `dream-cycle-summaries/<date>` or `takes.proposed` receipt pages by default, and no longer allows writes to `wiki/people/*`.**

### Changed
- The synthesize phase writes its cycle summary page only when `dream.synthesize.summary_page` is `true` (also `1`/`on`). Default off: the page only listed what the run wrote, which the cycle report already carries. The phase's `summary_slug` detail is `null` when it is off.
- The propose_takes phase writes its `extracts/<date>/takes.proposed/...` receipt page only when `dream.propose_takes.receipt_page` is on. Default off; the run rollup is still recorded.
- `wiki/people/*` is dropped from the dream write allow-list (`dream_synthesize_paths.globs` in `_brain-filing-rules.json`). People live in `people/`, and the synthesis prompt already forbids subagents from writing person pages, so the glob only opened a path no page type covers.
