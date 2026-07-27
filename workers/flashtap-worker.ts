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

    const url = `${appBaseUrl(env)}/api/cron/cleanup-stale-orders`
    const request = new Request(url, {
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
      handler
        .fetch(request, env, ctx)
        .then(async (res: Response) => {
          const body = await res.text()
          if (!res.ok) {
            console.error('[CRON] cleanup-stale-orders failed', res.status, body)
            return
          }
          console.log('[CRON] cleanup-stale-orders ok', body)
        })
        .catch((err: unknown) => {
          console.error('[CRON] cleanup-stale-orders fetch error', err)
        }),
    )
  },
} satisfies ExportedHandler<WorkerEnv>
