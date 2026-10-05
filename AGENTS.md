# Repository guidance

## Communication

- Use plain language. Explain necessary technical terms on first use.
- Lead with the outcome. Say what changed, what remains, and whether the user needs to act.
- For test or evaluation updates, give passed, failed, error, and pending counts. Use a small table when helpful. Do not call an unfinished run successful.
- Keep explanations brief. Add detail only when it helps the reader understand a decision or take action.

## Documentation

- Describe current behavior and limitations. Clearly label planned work.
- Keep the README focused on setup, configuration, running, and testing. Link to detailed guides.
- Keep guides concise and easy to scan: short sections, direct instructions, command examples, and tables where useful.
- Put dated evaluation history, run results, and review evidence in `reports/`.
- Keep all of `reports/` Git-ignored. Never commit generated reports or report archives.
- Avoid repeated information, unexplained jargon, implementation narration, and long progress summaries in guides.

## Workflow

- Start new work on a feature branch from refreshed main and open a remote PR for review.
- Do not add `Co-authored-by` trailers to commits.

## Cleanup

- Every feature, fix, and refactor must include cleanup in the same PR. Review the affected files and their callers for anything made obsolete.
- Remove unused files, components, classes, functions, exports, imports, dependencies, configuration, and generated artifacts. Check indirect use through scripts, framework conventions, configuration, and dynamic loading before deleting.
- Remove tests for retired behavior and preserve useful coverage of its replacement. Update documentation and lockfiles to match the current implementation.
- Run the relevant checks after cleanup. Before opening the PR, confirm that removed items have no remaining callers and that the supported paths still work.
