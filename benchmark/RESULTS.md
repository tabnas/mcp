# AX benchmark — runs

E1 of the agent-experience plan. `run.mjs --self-test` proves the benchmark
discriminates; this file records runs of an actual agent against it.

| date | agent | completed | retries | hallucinated APIs |
| --- | --- | --- | --- | --- |
| 2026-08-19 | Claude Opus 5 (Claude Code), `@tabnas/mcp@0.1.7` CLI | **10/10** | 2 | 1 |

Full per-task record:
[`results-2026-08-19-claude-opus-5.json`](results-2026-08-19-claude-opus-5.json).

## What the first run found

A 10/10 is a weaker result than it looks: it says the tasks are solvable by
a capable agent with the current tooling, not that the tooling is good. The
interesting output is the friction.

**The `expected` field is the best thing in the diagnostic.** Task 06 (a
grammar rejecting a bare top-level number) was solved in one step because
the failure carried `expected: ["#OB","#OS","#ST","#VL"]` and `#NR` was
plainly absent. No searching, no doc lookup. Everything that makes a
failure say what *would* have worked is worth more than everything that
describes what went wrong.

**`tn.use()` vs `tn.grammar()` is a trap worth fixing.** Task 10 asks for a
Node script that parses with a grammar; the first attempt called
`tn.use(grammar)`. `use` exists — it takes plugins — so the wrong call is
plausible rather than absurd, which is exactly what makes it likely. A
grammar passed to `use` could reasonably throw a message naming
`grammar()`.

**Task 04's premise is false, and the reason matters.** It says
`grammar.json` "is rejected by `tabnas validate`". It is not:
`validate` returns `{ok:true,v:2}`. The planted defect is `"p": "mapp"`, a
reference to a rule that does not exist, and **`validate_grammar` does not
check rule references** — it validates structure against the schema and
loads the grammar, neither of which resolves `p`/`r` targets. The engine
raises `unknown_rule` at parse time instead.

That is a gap in the tool, not just wrong task text. Reachability of named
rules is statically decidable and cheap: every `p` and `r` either names a
key in `rule` or it does not. Catching it in `validate_grammar` would turn
a parse-time surprise into an authoring-time error, which is the whole
point of having a validate step.

**Not attributable to tabnas, but real:** the documented invocation
`npx --yes @tabnas/mcp@<version>` failed twice in this harness when held in
a shell variable. Installing once and calling the binary directly was
markedly easier. Worth knowing that the documented form is the awkward one
for an agent working in a shell.
