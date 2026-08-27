# Discovery Note - Waiter-led service

Level 1. Not a decision record. States the problem, what exists measured
rather than assumed, and the rulings owed before an ADR.

Trigger check: touches money (tips), permissions (waiter assignment), state
shared across four clients, and a core domain concept (how an order reaches a
station). All Level 3 triggers, so an IDS is required.

## 1. The problem

Riviera will not start on QR. FlashTap is being introduced gradually, and the
first thing they want is the flow they run on paper: a waiter takes the order
at the table, the kitchen sees it on a screen, the bar sees its own part, and
the bill accumulates on the customer's tab.

Today FlashTap has three ordering channels - QR (table), kiosk, POS - and all
three assume the person ordering is the person paying. Waiter-led service
breaks that: the waiter enters the order, the customer never touches the app,
and the tab is created for them.

The kitchen screen is a wall-mounted monitor running Chrome. Not a device we
provision. A web page someone opens and nobody touches again. Waiters walk
INTO the kitchen to read it - they cannot see it from the doorway.

## 2. What exists today, measured

ALREADY BUILT AND USABLE
- Station routing: items[].route_to from menu_categories.route_to. Production
  counts: kitchen 2,823 - bar 492 - both 1,274 - null 4. Populated, never
  used to route anything.
- Tabs: create, join by PIN, add members, accumulate orders, settle. Live at
  Mingle and ChowNow.
- Terminal order creation: POST /api/terminal/orders - the POS channel
  already creates orders from a P5.
- Terminal auth: JWT, orders:read / orders:update / tables:read, restaurant-
  scoped, 1h expiry.
- Realtime: connection-state handling, refetch on reconnect, visibility
  listener, 60s polling fallback (#350, live on production).
- Order-level instructions: free text on the order.
- Order status vocabulary: pending, preparing, ready, completed, cancelled.
- Staff PINs: set at all three venues. Cash attribution works.

DOES NOT EXIST
- Kitchen display: no route, no component. kitchen_enabled is a flag labelled
  "Kitchen Display System" in the admin UI that gates nothing (#351).
- Bar display: same.
- Waiter to table assignment: no column, no concept anywhere.
- Per-item state: orders.items is JSONB. Item objects carry 17 keys and NOT
  ONE is a status, a ready flag, or a timestamp. There is no order_items
  table.
- Per-item notes reaching a station: item notes exist in the customer cart.
  Whether they survive to a kitchen surface is unverified.
- Tips: no field on any table. No terminal control. No receipt line.

## 3. The hazard that shapes everything

orders.status = 'completed' does not mean the food was made. It mostly means
PAID.

  completed orders on production          2,035
  completed_at == paid_at (same instant)  ~99.5%
  currently in 'ready'                        6
  currently in 'preparing'                    1

markOrderPaidConfirmed writes completed from any prior status, and the
table-close route bulk-stamps it. The kitchen states exist in the schema and
have effectively never been used. A kitchen display depends entirely on
states the kitchen has never driven. Any design reading 'completed' as "the
food happened" is reading a payment event.

## 4. The flow, as Riviera described it

1. Customer sits. Waiter is assigned to that table.
2. Waiter takes the order on the P5 - creating a tab, or adding to one.
3. Order splits by route_to: food to the kitchen screen, drinks to the bar
   screen. An order containing both appears on both, each station seeing only
   its own lines.
4. Per-item notes ride with the line - "medium", "well done".
5. Station marks lines done. Runner takes food out.
6. Bill accumulates on the tab.
7. At settle, the waiter can add a tip before taking payment.

## 5. Core concepts

STATION. A destination for a line. route_to exists with three values and has
never routed anything.

ASSIGNMENT. Which waiter owns a table for the current session. New.

TAB. Exists. What changes is who creates it - and that has a consequence
nobody designed for: a tab with no session token, because no customer
scanned.

LINE STATE. Whether an individual item is outstanding or done. Does not
exist. The schema decision everything hangs off.

## 6. User events - the acceptance criteria

ORDERING
A. Waiter opens a table and is shown its current tab, or the option to start
   one.
B. Waiter adds items for a customer who has never touched the app.
C. Waiter adds a note to a single line - "medium".
D. Waiter adds a second round to a tab that already has orders.
E. A second waiter opens the same table while the first is mid-order.
F. Waiter is assigned to a table; a different waiter tries to add to it.

STATIONS
G. An order with food and drinks appears on both screens, each showing only
   its own lines.
H. An item routed 'both' - what does that mean, and where does it appear?
I. Kitchen marks a line done. Bar's view of the same order is unaffected.
J. Kitchen marks the last outstanding line done. What happens to the card?
K. A line is done at the kitchen while the same order's drink is still
   outstanding at the bar. What does a runner see?
L. An order is amended after the kitchen has started it.
M. An order is cancelled after the kitchen has started it.

THE SCREEN ITSELF
N. The screen has been open, untouched, for a week. It still works.
O. The wifi drops for two minutes and comes back. Orders placed during the
   gap appear.
P. The venue loses power. The screen comes back to the right page with nobody
   touching it.
Q. Someone in the kitchen presses the wrong thing. What can they break?

MONEY
AA. Waiter adds a tip at settle. Where does it appear on the bill, the
    receipt and the takings?
AB. A tab is settled part-cash, part-card, with a tip.
AC. A tip is added and then the payment fails.
AD. Tips are reported - per waiter, per shift, or not at all.

Events R through Z are the inventory track and belong to the other session.

## 7. What must not be assumed

- That the kitchen will drive the status flow. It never has. If the design
  needs reliable bumping, that is a behaviour change at the venue, not a
  feature.
- That 'completed' is available as a signal. It means paid.
- That the screen will be looked after. Nobody will reopen a browser tab.
- That route_to is correct. Populated is not verified. 4 null, 1,274 'both' -
  and 'both' is a category default nobody changed, not a routing decision.
