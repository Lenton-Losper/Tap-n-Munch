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
    ctx.waitUntil(
      fetch(url, {
        method: 'POST',
        headers: { 'x-cron-secret': secret },
      })
        .then(async (res) => {
          const body = await res.text()
          if (!res.ok) {
            console.error('[CRON] cleanup-stale-orders failed', res.status, body)
            return
          }
          console.log('[CRON] cleanup-stale-orders ok', body)
        })
        .catch((err) => {
          console.error('[CRON] cleanup-stale-orders fetch error', err)
        }),
    )
  },
} satisfies ExportedHandler<WorkerEnv>
