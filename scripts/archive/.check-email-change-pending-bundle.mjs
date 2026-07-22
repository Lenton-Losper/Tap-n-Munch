const base = 'https://www.flashtap.app'
const pages = ['/settings', '/']
const marker = 'email_change_pending'
const foundIn = []

for (const path of pages) {
  const res = await fetch(base + path)
  const html = await res.text()
  const chunks = [...new Set([...html.matchAll(/\/_next\/static\/[^"']+\.js/g)].map((m) => m[0]))]
  console.log(path, 'status', res.status, 'chunks found:', chunks.length)
  for (const chunk of chunks) {
    try {
      const js = await (await fetch(base + chunk)).text()
      if (js.includes(marker)) {
        foundIn.push(chunk)
        console.log('  MATCH in', chunk)
      }
    } catch {
      /* ignore chunk fetch errors */
    }
  }
}

console.log('\nTotal chunks containing', marker, ':', foundIn.length)
