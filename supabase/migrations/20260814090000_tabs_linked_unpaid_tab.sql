-- The unpaid-tab-elsewhere flag.
--
-- RULINGS (human, 2026-08-13): FLAG, do not block. Staff-only — the customer is never told.
-- The link is recorded AT CREATION of the new tab. It clears when the linked tab settles. If the
-- customer's browser storage was cleared there is no link to record, and that is accepted.
--
-- WHAT IT IS FOR. #211 fixed the dead end where a customer holding an open tab at table A scanned
-- table B and was offered only "rejoin", which the server correctly refused. They can now start
-- fresh at table B — which means a customer can legitimately hold an open, unpaid tab at another
-- table while ordering here. Staff have no way to see that, and it is exactly the thing a floor
-- manager wants to know before the second tab is settled and the customer leaves.
--
-- WHY A COLUMN AND NOT A QUERY. "Does this customer have another open tab" could in principle be
-- derived by scanning tabs.members for a shared session id. It must not be: members holds raw
-- session ids, 20260811120000 just took that column off the anon grant precisely because a
-- session id is a credential, and a derived query would have to read it on every dashboard poll.
-- The link is a fact known once, at creation, by the client that holds both — so it is recorded
-- once, as an id, and never re-derived.
--
-- WHY NOT CLEARED ON SETTLE BY A WRITE. `clears on settle` is implemented as a READ: the
-- dashboard renders the flag only while the LINKED tab is still open/ready_to_pay. That needs no
-- write on the settle path — which is payment-adjacent and already does several things — and it
-- cannot leave a stale flag behind if a settle path is ever added that forgets to clear it. The
-- column is a pointer, not a boolean, which is what makes that possible.
--
-- NULLABLE, no default, no FK cascade concerns: it references another tab in the same restaurant
-- and is allowed to point at a tab that has since been settled or deleted. A dangling pointer
-- reads as "no flag", which is the safe direction.

ALTER TABLE public.tabs
  ADD COLUMN IF NOT EXISTS linked_unpaid_tab_id uuid;

COMMENT ON COLUMN public.tabs.linked_unpaid_tab_id IS
  'The still-unpaid tab this customer held elsewhere when THIS tab was created (#211 follow-up). Staff-only signal; the flag renders only while the linked tab is still open, so it clears on settle without a write. NULL when the customer had no other tab, or when their browser had no record of one.';

-- Partial: the overwhelming majority of tabs have no link, and the dashboard only ever looks up
-- the ones that do.
CREATE INDEX IF NOT EXISTS tabs_linked_unpaid_tab_id_idx
  ON public.tabs (linked_unpaid_tab_id)
  WHERE linked_unpaid_tab_id IS NOT NULL;
