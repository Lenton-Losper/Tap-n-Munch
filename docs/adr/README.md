# Architecture Decision Records

This folder records significant architectural and infrastructure
decisions for FlashTap — not just what was decided, but why, what
assumptions it rested on, and what happened when those assumptions
were tested.

## When to write one
- Any decision that changes how a core service, data model, or
  infrastructure layer works
- Any decision made after discovering an existing plan's assumptions
  were wrong
- Any decision requiring mentor sign-off before implementation

## Format
Each ADR is a numbered Markdown file: `NNN-short-title.md` (e.g.
`001-dns-authority-discovery.md`). Use the template below.

## Status values
- `Proposed` — drafted, not yet reviewed
- `Approved` — reviewed and signed off, not yet implemented
- `Implemented` — built and deployed
- `Operationally Complete` — implemented and verified; any remaining
  items are hardening/follow-up, not blockers
- `Superseded by ADR-NNN` — replaced by a later decision
- `Absorbed by ADR-NNN` — a reserved slot that never carried a decision; a
  later ADR took over its scope. The file is kept as a redirect so the
  numbering stays unbroken.

## Template

# ADR-NNN: [Title]

**Status:** [status]
**Date:** [date]

## Context
What situation led to this decision? What was the original plan or
assumption?

## Decision
What was actually decided/done?

## Consequences
What are the results — intended and unintended? What was verified?
What remains open?

## Mentor sign-off
[If applicable]
