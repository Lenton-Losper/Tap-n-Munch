// Custom OpenNext entry: reuses the generated fetch handler and adds a scheduled()
// handler so Cloudflare Cron Triggers can hit our Next.js cleanup route.
// See https://opennext.js.org/cloudflare/howtos/custom-worker

// @ts-expect-error `.open-next/worker.js` is generated at build time
import { default as handler } from '../.open-next/worker.js'

type WorkerEnv = {
  ENVIRONMENT?: string
  CRON_SECRET?: string
  NEXT_PUBLIC_APP_URL?: string
}

function appBaseUrl(env: WorkerEnv): string {
  if (env.NEXT_PUBLIC_APP_URL) return env.NEXT_PUBLIC_APP_URL.replace(/\/$/, '')
  if (env.ENVIRONMENT === 'production') return 'https://flashtap.app'
  return 'https://flashtap-staging.llosperofficial.workers.dev'
}

export default {
  fetch: handler.fetch,

  async scheduled(
    _controller: ScheduledController,
    env: WorkerEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    const secret = env.CRON_SECRET
    if (!secret) {
      console.error('[CRON] CRON_SECRET missing on worker env; skipping cleanup-stale-orders')
      return
    }

    // All cron routes are driven off this one every-2-minutes trigger. send-scheduled-reports returns
    // immediately unless a schedule's local send_time has been reached, so per-restaurant
    // send times cost nothing extra and a missed tick catches up on the next one.
    // reconcile-sale-ledger self-gates the same way, to an hourly cadence, off its own
    // heartbeat row -- it reports SALE ledger coverage per venue and gates nothing (#156).
    const cronRoutes = [
      'cleanup-stale-orders',
      'send-scheduled-reports',
      'reconcile-sale-ledger',
    ] as const

    const requestFor = (route: string) =>
      new Request(`${appBaseUrl(env)}/api/cron/${route}`, {
        method: 'POST',
        headers: { 'x-cron-secret': secret },
      })

    ctx.waitUntil(
      // In-process call into the compiled Next.js handler -- NOT the global fetch().
      // handler.fetch is the exact same function reference this Worker's own `fetch`
      // export uses; calling it directly here is a plain JS function call within the
      // same isolate, so there is no HTTP round-trip, no DNS/TLS/edge routing back
      // into this zone, and nothing that can time out with a 522. It still runs
      // through the real compiled /api/cron/cleanup-stale-orders route (same
      // requireCronSecret check, same autoCancelStalePosOrders/expireHostedPendingOrders/
      // reconcileOrphanPayments logic), because handler.fetch internally wraps every
      // call in runWithCloudflareRequestContext(request, env, ctx, ...), which is what
      // populates process.env from the Workers env bindings -- so this call gets that
      // same setup even though it's not a real inbound request.
      //
      // Previously this used the global fetch(url, ...) to hit this same URL, which
      // Cloudflare routes back out through its edge into the Worker's own zone --
      // that self-referential request was timing out with a 522 on every single cron
      // tick (confirmed via Cloudflare Observability logs), so cleanup-stale-orders
      // never ran at all.
      // One route failing must not stop the other, so each settles independently.
      Promise.allSettled(
        cronRoutes.map((route) =>
          handler
            .fetch(requestFor(route), env, ctx)
            .then(async (res: Response) => {
              const body = await res.text()
              if (!res.ok) {
                console.error(`[CRON] ${route} failed`, res.status, body)
                return
              }
              console.log(`[CRON] ${route} ok`, body)
            })
            .catch((err: unknown) => {
              console.error(`[CRON] ${route} invoke error`, err)
            }),
        ),
      ),
    )
  },
} satisfies ExportedHandler<WorkerEnv>
