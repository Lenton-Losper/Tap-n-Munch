#!/usr/bin/env node
/**
 * Delete conflicting Vercel-origin A records for www + riviera so wrangler
 * custom_domain routes can register on flashtap-production.
 */
const token =
  process.env.CLOUDFLARE_DNS_TOKEN ||
  process.env.CLOUDFLARE_API_TOKEN_SHADOW ||
  process.env.CLOUDFLARE_API_TOKEN;
const zoneId = '9fce22c09d6c7ac737d7d53d250c3e72';
const hostnames = ['www.flashtap.app', 'riviera.flashtap.app'];

if (!token) {
  console.error('CLOUDFLARE_DNS_TOKEN or CLOUDFLARE_API_TOKEN_SHADOW required');
  process.exit(1);
}

async function cf(path, opts = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function main() {
  console.log('=== DNS records (www + riviera + apex) ===');
  const dns = await cf(`/zones/${zoneId}/dns_records?per_page=100`);
  if (!dns.json.success) {
    console.error('DNS list failed:', JSON.stringify(dns.json.errors));
    process.exit(1);
  }

  for (const r of dns.json.result) {
    if (['www.flashtap.app', 'riviera.flashtap.app', 'flashtap.app'].includes(r.name)) {
      console.log(`${r.type}\t${r.name}\t${r.content}\tproxied=${r.proxied}\tid=${r.id}`);
    }
  }

  console.log('\n=== Delete conflicting A records ===');
  for (const name of hostnames) {
    const records = dns.json.result.filter((r) => r.name === name && r.type === 'A');
    for (const r of records) {
      const del = await cf(`/zones/${zoneId}/dns_records/${r.id}`, { method: 'DELETE' });
      console.log(
        `DELETE ${name} A ${r.content}:`,
        del.json.success ? 'OK' : JSON.stringify(del.json.errors),
      );
      if (!del.json.success) process.exit(1);
    }
    if (records.length === 0) {
      console.log(`No A records for ${name} (ready for worker custom domain)`);
    }
  }

  console.log('\nDone — wrangler deploy will register worker custom domains.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
