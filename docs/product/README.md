# Product record

This folder is the product-management record behind UNMASK, written during
Hacktoberfest 2026 (31 October to 1 November). It shows what we set out to
build, which decisions we made and why, how we planned to test it, and where we
were honest about limits.

The documents are kept as written. Each one opens with a banner that dates it.
Statuses inside a document describe that moment, so a feature marked
**[P]** may have shipped later. The [then and now](#then-and-now) table below
gives the current state.

## Read in this order

| Time  | Document                                               | What it answers                                                       |
| ----- | ------------------------------------------------------ | --------------------------------------------------------------------- |
| 5 min | [PRD](prd.md)                                          | The problem, users, scope, non-goals, principles and success criteria |
| 3 min | [User journeys](user-journeys.md)                      | How a developer, a judge and an operator use UNMASK, as diagrams      |
| 5 min | [Demo and evaluation plan](demo-eval-plan.md)          | The fixtures, the metrics, the 3-minute demo and its honesty guards   |
| 5 min | [Decisions log](decisions-log.md)                      | Every decision made under time pressure, with its source and effect   |
| 3 min | [Model gate pre-registration](gate/PREREGISTRATION.md) | How the AI will be scored, frozen before any model output             |

## All documents

**Product definition**

- [prd.md](prd.md): product requirements
- [user-journeys.md](user-journeys.md): use cases, flows and sequence diagrams
- [user-stories.md](user-stories.md): stories with acceptance criteria and priority
- [delivery-handoff.md](delivery-handoff.md): first vertical slice, build order and lane ownership

**Evaluation**

- [demo-eval-plan.md](demo-eval-plan.md): evaluation set, metrics and demo script
- [gate/](gate/): model-gate pre-registration, runner, scorer and scorer commitment

**Decisions and review**

- [decisions-log.md](decisions-log.md): timestamped decisions after the engineering proposal froze
- [pm-product-grill.md](pm-product-grill.md): an independent challenge of the product, with answers

**Next increments**

- [whole-package-gap.md](whole-package-gap.md): what a one-minute package summary is missing today
- [dossier-acceptance.md](dossier-acceptance.md): staged acceptance for that summary, then an OSV lookup

**Research (inputs to the decisions above)**

- [pm-evidence-notes.md](pm-evidence-notes.md): first-hand registry and tarball measurements
- [claude-pain-differentiation.md](claude-pain-differentiation.md): incidents, user pain and differentiation
- [codex-ecosystem-partial.md](codex-ecosystem-partial.md): npm and PyPI source-mapping feasibility (partial)
- [pm-product-recommendation.md](pm-product-recommendation.md): the recommendation that set the scope
- [pm-scope-addendum-hosted.md](pm-scope-addendum-hosted.md): the hosted-website and release addendum

## Then and now

| Planned capability                      | When written        | On 1 November 2026                                                               |
| --------------------------------------- | ------------------- | -------------------------------------------------------------------------------- |
| Check `name@version` on a website       | [P]                 | Shipped: analysis API and Next.js website on Google Cloud Run                    |
| Check `name@version` from the CLI       | [P]                 | Shipped: hosted by default, with no local model key                              |
| Check a local `.tgz` offline            | [P], mandatory      | Shipped: `--offline`; 11/11 planted fixtures localized by the installed CLI      |
| CLI and website give the same report    | [P]                 | Verified on chalk 6.0.1: identical canonical report hash                         |
| One npm distribution                    | [P], [B] on npm     | Published: `@xagents_in/unmask@0.1.0`                                            |
| Versioned CI release bound to the image | [P]                 | Shipped: immutable GitHub release; image built from the exact tarball            |
| Deploy by image digest                  | [P] on DigitalOcean | Changed: deployed on Google Cloud Run instead                                    |
| AI explanations with checked citations  | [P], [B] on a key   | Working: 3 validated hypotheses on zod 4.6.7 from Gemini 3.5 Flash (smoke test)  |
| Open-weight model acceptance            | [B]                 | Not met: Gemma is the configured fallback, but no Gemma output has been accepted |
| Five-fixture model gate                 | [P]                 | Pre-registered and scorer frozen; not yet run                                    |
| Human grading of model usefulness       | [P]                 | Not met: no human grader assigned                                                |
| Website `.tgz` upload                   | Removed             | Out of scope; local files use the CLI                                            |
| Package summary ("dossier")             | [P]                 | Proposed in `dossier-acceptance.md`                                              |
| PyPI and release monitoring             | Unmet objective     | Not implemented                                                                  |

## Glossary

- **[V] verified, [P] proposed, [B] blocked, [H] hypothesis.** Status tags used in
  every document. **[E]** in the research memos means evidence.
- **PM, EM, root, child, lane.** The roles used while building. PM owned product
  decisions, EM owned engineering, root coordinated the repository, and each
  child or lane owned one area (server, web, package, fixtures).
- **v16 to v27.** Versions of the engineering proposal. Each was frozen by hash, so
  later decisions were logged in `decisions-log.md` instead of editing it.
- **Grill.** An independent review round that challenged a proposal before
  approval.
- **V1 to V8, H1 and H2.** Planted-change fixtures on real packages (chalk, axios),
  and two sealed holdouts that are never used for tuning.
- **B1.** The non-AI baseline that model results are compared against.
- **EM #nnnnn.** The message that relayed a decision, so each log row is traceable.

## What was changed for publication

These documents were private working notes. Before publishing we:

- removed cloud project and organization identifiers, numeric repository
  identifiers, a private link, and local file paths
- replaced the "internal only" opening lines with the dated banner
- left everything else as written, including statements that are now out of date

Paths that start with `../` (fixtures, runtime logs, engineering proposals)
point to the team's research workspace, which is not published. Their SHA-256
hashes are quoted so the files can be checked if they are released.

The files in [gate/](gate/) are unchanged byte for byte, including the original
workspace path in the two scripts. Their hashes are recorded in
`gate/SCORER-COMMITMENT.json` and in the decisions log, so editing them would
break the pre-registration.
