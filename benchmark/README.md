# The AX benchmark

Ten tasks that measure whether an agent can actually do the top tabnas
workflows — the plan's E1, and the answer to a question the project could
otherwise only guess at:

> Not "do we have good agent documentation?" but **"can current agents
> complete the top ten tabnas workflows reliably?"**

**No agent has been measured yet.** This directory defines the tasks, the
starting state for each, and a machine check that decides completion. Running
agents against it is a separate, scheduled activity — deliberately not a
per-PR one, because agent runs are slow, cost money, and are noisy enough that
gating a merge on them would teach people to ignore the result.

## The ten tasks

| | Task | What it exercises |
|---|---|---|
| 01 | Install tabnas and prove it runs | discovery: the tool is not named in the prompt |
| 02 | Parse a supplied document | the basic path, start to finish |
| 03 | Create a simple grammar | authoring a `GrammarSpec` that validates |
| 04 | Fix a deliberately broken grammar | reading a validation failure and acting on it |
| 05 | Explain a parse failure | the structured diagnostic — code, row, col |
| 06 | Add a rule to an existing grammar | extension without regression |
| 07 | Write parser fixtures | the `.tsv` convention, and `ERROR:<code>` over bare `ERROR` |
| 08 | Upgrade a plugin descriptor | descriptor rules, including the no-`version` one |
| 09 | Compare two grammar versions | using the tool to find a behavioural difference |
| 10 | Integrate tabnas into a small application | it works outside a tutorial |

## Running it

```bash
cd ts && npm run build          # the tasks drive the built CLI
node benchmark/run.mjs --self-test               # verify the benchmark itself
node benchmark/run.mjs --scaffold --out ./run    # materialise the tasks
#   ... an agent works in ./run/<task>/, following each TASK.md ...
node benchmark/run.mjs --score --out ./run       # decide completion
```

`--self-test` takes a task id (or prefix) to run one: `run.mjs 04`.

## Why there is a self-test

A benchmark is a measuring instrument, and an instrument nobody has checked
is decoration. `--self-test` proves two things about **every** task, and runs
in CI:

1. **It is solvable.** The task carries a reference solution; the check must
   pass on it. A task that has quietly rotted into something impossible —
   because a flag was renamed, or the CLI's output shape changed — fails here
   rather than being reported as "no agent could do it".
2. **Its check discriminates.** The task also carries a deliberately wrong
   answer, and the check must *reject* it. A grader that accepts anything
   measures nothing, and every check here has been made to fail on purpose.

Both halves have earned their keep already: the first run of the self-test
found four tasks whose reference solutions read the wrong key out of the
CLI's `--json` output, and one whose grammar parsed to an empty array.

The wrong answers are chosen to be *plausible*, not absurd — task 07's is
three passing rows and a bare `ERROR` (rejection asserted, code not), and
task 10's is a script that prints the right number without parsing anything,
which is caught only because the check runs it a second time on an input the
agent never saw.

## What is measured

`--score` decides `completed` and nothing else, because completion is the only
metric visible in the finished state. The rest are properties of *how* the
agent got there and are counted from its transcript:

| Metric | Counted from |
|---|---|
| `completed` | `run.mjs --score` |
| `retries` | re-attempts after a failure |
| `invalid_commands` | commands that do not exist, or were malformed |
| `hallucinated_apis` | references to tabnas functions, flags or files that do not exist |
| `docs_consulted` | documentation pages or MCP resources opened |
| `test_failures` | failing test or fixture runs before the final state |
| `steps_to_first_parse` | agent actions until the first successful parse |

`--scaffold` writes `scoresheet.json` with a row per task to fill in, so
results from different agents and different dates stay comparable.

`hallucinated_apis` is the one worth watching hardest: it is the metric that
says whether the documentation, the schemas and the error registry are doing
their job, or whether an agent is filling gaps by invention.

## Adding a task

Add an entry to `tasks.mjs` with `setup`, `prompt`, `solve`, `spoil` and
`check`. The self-test will tell you immediately if the task cannot be solved
or if the check accepts the wrong answer — which is the point of writing both
of those before trusting the task.

Keep fixtures small. A task should fail because the agent got it wrong, not
because the starting state was too large to reason about.
