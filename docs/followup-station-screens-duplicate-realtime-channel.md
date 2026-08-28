# Follow-up: station screens double the Realtime channel count per restaurant

**Filed 2026-08-28. Not urgent tonight — no user-visible effect. Will matter once Riviera's
screens carry real load.**

## The finding

`subscribeRestaurantOrdersRealtime` (`lib/supabase/orders.ts`) was extended with an optional
`onLineChange` callback so the kitchen/bar screens could reuse it rather than fork a second
subscriber (ruled, feat/station-screens-v1). Each *caller* still makes its own call to the
function, and each call makes its own `supabase.channel(name)` call — the channel name is
restaurant-scoped (`orders-channel-${restaurantId}`), not de-duplicated across callers.

So when the staff dashboard (`components/orders-dashboard.tsx`) and a kitchen or bar screen are
both open for the **same restaurant**, two independent Realtime channel objects get created,
each opening its own WebSocket subscription to the same `orders-channel-<id>` topic — one
receiving `orders` changes, one receiving `order_lines` changes, but both paying full connection
overhead for a restaurant that used to have exactly one subscriber.

## The measurement

`__tests__/station-realtime-duplicate-channel-measurement.test.ts` drives
`subscribeRestaurantOrdersRealtime` with the dashboard's own call shape and a station screen's
own call shape, concurrently, for `restaurantId: 'r1'`, and counts the mocked `supabase.channel`
calls:

```
expect(channelFactory).toHaveBeenCalledTimes(2)
expect(channelFactory).toHaveBeenNthCalledWith(1, 'orders-channel-r1')
expect(channelFactory).toHaveBeenNthCalledWith(2, 'orders-channel-r1')
```

Both calls target the identical channel name. supabase-js does not deduplicate same-named
channels created from two call sites — each is a fully independent subscription.

## Why it is correctness-neutral tonight

Both subscribers still receive every event correctly (the same test file's siblings prove the
dashboard's own path is byte-identical to before, and that `onLineChange` fires from a real
`order_lines` payload) — this is pure **overhead**, not a functional bug. A venue running one
kitchen screen, one bar screen, and the dashboard concurrently opens three sockets against one
restaurant's channel where one would do.

## Why it is not being fixed tonight

Ruled 2026-08-28: `lib/dashboard/realtime-connection.ts` (#350's resilience layer) is not
something to touch under time pressure for a change with no visible symptom. The near-miss
history in `docs/agent-operating-contracts.md` is explicit about what happens when infrastructure
this load-bearing gets edited without room to verify it properly.

## The follow-up, not built here

A small per-restaurant channel registry inside `subscribeRestaurantOrdersRealtime` itself —
reference-counted, one real `supabase.channel()` per restaurant regardless of how many callers
ask for it, torn down only when the last subscriber unmounts. Belongs in
`lib/supabase/orders.ts` alongside the function it would change, not a second module — same
"extend it, don't fork it" instinct that produced `onLineChange` in the first place.

Worth doing once Riviera's kitchen and bar screens are actually carrying dinner-service load
alongside the dashboard, not before.
