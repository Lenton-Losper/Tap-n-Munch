# Overnight sprint — 2026-08-11, unsupervised

Checkpointed continuously. Assume it was cut off mid-sentence; nothing here waits for the end.

## Ground state at sprint start

- `origin/main` = **fdb999a** = production, verified cache-busted.
- Contract: `docs/agent-operating-contracts` @ **ed99f3c** (revision 2) governs.
- HARD STOPS in force: nothing pushes to main, nothing deploys, no production writes, no
  migrations applied, #127 untouched. Money-facing changes become packets.
- NEW ROLE this sprint: **Exploiter** — an instance independent of the writer must attempt the
  ORIGINAL reproduction against the fixed code before anything is called done. "Unable to reach
  the condition" is NOT "fixed" and is reported as PROOF CEILING blocked.

## What shipped earlier today, for context

Nine production deploys, 21d5133 -> fdb999a. Closed: #202, #195, #204, #192, #194, #177 (refiled
as #216), #190, #197, #201, #146, #191, #205, #210, plus #122's union verified live. Filed:
#211-#216.

## Agents dispatched (all branch-only, none may push)

| Agent | Branch | Work |
|---|---|---|
| `sp-stock-pay` | `sprint/stock-pay` | #146 prevention packet (file the issue), #187 remaining packet, then #199 reachability |
| `sp-qr-state` | `sprint/qr-state` | #211 packet, #215 packet + staging `accepting` count, #189 remaining scope |
| `sp-receipt` | `sprint/receipt` | #165 packet (arithmetic already settled — copy only), #139 answered either way, #212 lint rule (implementable) |
| `sp-variants` | `sprint/variants` | #200's real lead: are the five `required:true` variant-group items ORDERABLE. No pricing changes. |
| `sp-browse` | `sprint/browse-states` | #214 three states — ruled and implementable, copy-free path required |

## Findings as they land

_(appended below as handoffs arrive)_

## Skipped, with reason

- **#127** and anything touching duplicate order numbers — standing hard stop.
- **#129, #174/#175, #186, #139-as-a-fix** — the half-fixed four; promoting them would make them
  look done. #139 is being *investigated* only, which is the explicit instruction.
- Anything needing a migration applied — the drift guard blocks every deploy while a committed
  migration is unrecorded, and applying one is the human's.
