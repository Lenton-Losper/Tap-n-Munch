// Fires N HTTP requests as close to simultaneously as possible and reports each result.
// Usage: node audit-concurrent-fire.mjs '<json array of {url, method, headers, body}>'
const requests = JSON.parse(process.argv[2])

async function fire(reqSpec) {
  const t0 = performance.now()
  const res = await fetch(reqSpec.url, {
    method: reqSpec.method || 'GET',
    headers: reqSpec.headers || {},
    body: reqSpec.body ? JSON.stringify(reqSpec.body) : undefined,
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* not json */
  }
  return { status: res.status, body: json ?? text, ms: Math.round(performance.now() - t0) }
}

const results = await Promise.all(requests.map(fire))
console.log(JSON.stringify(results, null, 2))
