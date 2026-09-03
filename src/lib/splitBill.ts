/**
 * src/lib/splitBill.ts — the pure half of item-level bill splitting.
 *
 * React-free and fetch-free, so the rules that decide WHO OWES WHAT are pinned by tests rather
 * than by reading a screen. Same split as tabLines.ts, and for the same reason: this is money.
 *
 * ============================================================================================
 * NOTHING HERE COMPUTES AN AMOUNT
 * ============================================================================================
 *
 * Every figure below is either a server-supplied integer-cent value or a SUM of them. The device
 * never divides, never rounds, and never derives a share.
 *
 * That is deliberate and it is the whole safety property. The server splits a line with
 * splitCentsByWeight() in integer cents, so the allocations for a line provably sum to exactly the
 * line's own total — never a cent short, never a cent over, by construction. A second, independent
 * division on the device would be a second answer to the same question, and the two would disagree
 * on exactly the inputs that matter (an odd number of cents shared by two people). The device asks
 * for a split and displays what came back.
 *
 * `amount_cents` is therefore read, summed, and formatted. Never computed.
 */

/** One allocation as the server reports it. Integer cents; `settled_at` non-null means paid. */
export interface TabLineAllocation {
  id: string;
  allocated_to: string;
  quantity_allocated: number;
  amount_cents: number;
  settled_at: string | null;
}

/**
 * The split-relevant fields the lines payload now carries. Optional throughout: a server that
 * predates the split sends none of them, and `undefined` must behave as "this line cannot be
 * split", not as a crash and not as a free line.
 */
export interface SplittableLine {
  id: string;
  name_snapshot: string;
  quantity: number;
  is_voided: boolean;
  total_cents?: number | null;
  allocations?: TabLineAllocation[];
  allocated_cents?: number;
}

/** Cents still unassigned on a line. Zero when fully assigned; null when the line has no price. */
export function unallocatedCents(line: SplittableLine): number | null {
  if (line.total_cents == null || !Number.isFinite(line.total_cents)) {
    return null;
  }
  const allocated = Number(line.allocated_cents ?? 0);
  return Math.max(0, line.total_cents - (Number.isFinite(allocated) ? allocated : 0));
}

/**
 * Whether this line can be split RIGHT NOW.
 *
 * Three refusals, each for a different reason:
 *
 *   - a VOIDED line is not owed by anyone. The server would refuse the allocation anyway; refusing
 *     here means the waiter is told rather than tapping into an error.
 *   - an UNPRICEABLE line (total_cents null) cannot be divided into amounts that sum to it. The
 *     server derives the price from orders.items[source_item_index].total, and when that is
 *     missing or malformed it returns null rather than guessing. A screen must not guess either.
 *   - a line with ANY SETTLED allocation cannot be re-split. That is the server's own rule
 *     (ALREADY_SETTLED, 409): money has already changed hands against part of this line, and
 *     re-dividing it would move an amount somebody has already paid.
 */
export function canSplitLine(line: SplittableLine): boolean {
  if (line.is_voided) return false;
  if (line.total_cents == null || !Number.isFinite(line.total_cents)) return false;
  return !(line.allocations ?? []).some(a => a.settled_at != null);
}

/** Why `canSplitLine` said no — so the screen can say which of the three it is. */
export type SplitRefusal = 'voided' | 'unpriced' | 'already_settled' | null;

export function splitRefusal(line: SplittableLine): SplitRefusal {
  if (line.is_voided) return 'voided';
  if (line.total_cents == null || !Number.isFinite(line.total_cents)) return 'unpriced';
  if ((line.allocations ?? []).some(a => a.settled_at != null)) return 'already_settled';
  return null;
}

/** What one person owes, and what they have already paid, across every line on the tab. */
export interface PersonSplit {
  name: string;
  /** Allocation ids still unsettled — exactly what the settle call takes. */
  unsettledAllocationIds: string[];
  unsettledCents: number;
  settledCents: number;
}

/**
 * Everyone with an allocation on this tab, with their unsettled total.
 *
 * SUMMED FROM SERVER AMOUNTS, never divided. Sorted by name so the collect screen does not reorder
 * itself between refreshes while a waiter is looking at it — a list that reshuffles under a finger
 * is how the wrong person gets charged.
 */
export function personSplits(lines: SplittableLine[]): PersonSplit[] {
  const byName = new Map<string, PersonSplit>();

  for (const line of lines) {
    for (const a of line.allocations ?? []) {
      const name = String(a.allocated_to ?? '').trim();
      if (!name) continue;
      const entry = byName.get(name) ?? {
        name,
        unsettledAllocationIds: [],
        unsettledCents: 0,
        settledCents: 0,
      };
      const cents = Number(a.amount_cents) || 0;
      if (a.settled_at == null) {
        entry.unsettledAllocationIds.push(a.id);
        entry.unsettledCents += cents;
      } else {
        entry.settledCents += cents;
      }
      byName.set(name, entry);
    }
  }

  return [...byName.values()].sort((x, y) => x.name.localeCompare(y.name));
}

/**
 * Names to offer when assigning, best-first.
 *
 * The owner's ruling: offer `tabs.members` first, with a free field as fallback — "don't make a
 * waiter retype a name the table already has."
 *
 * Members come first in their own order (that is the order the table was opened with, which is the
 * order the waiter thinks in). Anyone who already has an allocation but is not a member is
 * appended, so a name typed by hand earlier stays one tap away for the next line.
 */
export function assignableNames(
  members: readonly string[] | null | undefined,
  lines: SplittableLine[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const m of members ?? []) {
    const name = String(m ?? '').trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  for (const p of personSplits(lines)) {
    if (seen.has(p.name.toLowerCase())) continue;
    seen.add(p.name.toLowerCase());
    out.push(p.name);
  }
  return out;
}

/**
 * The shares to send for a whole-line or half-line assignment.
 *
 * HALF ONLY — the owner ruled out N-way: "three people sharing a pizza is a rounding argument at
 * the table, and N-way is more ways to mis-tap mid-service."
 *
 * `quantity_allocated` is a WEIGHT, not a price. The server splits the line's own total across
 * these weights in integer cents, so two 0.5 shares of an odd-cent line come back as (for example)
 * 1667 and 1666 — summing exactly, with the server deciding who carries the extra cent. The device
 * expresses intent and never the amount.
 */
export type ShareMode = 'whole' | 'half';

export function sharesFor(
  mode: ShareMode,
  name: string,
  otherName: string | null,
): Array<{allocated_to: string; quantity_allocated: number}> {
  const primary = name.trim();
  if (mode === 'whole' || !otherName || !otherName.trim()) {
    return [{allocated_to: primary, quantity_allocated: 1}];
  }
  return [
    {allocated_to: primary, quantity_allocated: 0.5},
    {allocated_to: otherName.trim(), quantity_allocated: 0.5},
  ];
}

/** Cents still owed across the whole tab — what stays open after a partial settlement. */
export function tabRemainderCents(lines: SplittableLine[]): number {
  let remainder = 0;
  for (const line of lines) {
    if (line.is_voided) continue;
    const total = line.total_cents;
    if (total == null || !Number.isFinite(total)) continue;
    const settled = (line.allocations ?? [])
      .filter(a => a.settled_at != null)
      .reduce((sum, a) => sum + (Number(a.amount_cents) || 0), 0);
    remainder += Math.max(0, total - settled);
  }
  return remainder;
}

/** `1234` -> `NAD 12.34`. Formatting only; the cents figure is the server's. */
export function formatCents(cents: number): string {
  const value = (Number(cents) || 0) / 100;
  return `NAD ${value.toFixed(2)}`;
}
