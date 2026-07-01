#!/usr/bin/env node
const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || 'b74d9cfb3ba0e345287429ca237ecbfd';
const zoneId = '9fce22c09d6c7ac737d7d53d250c3e72';
const service = 'flashtap-production';
const hostnames = ['www.flashtap.app', 'riviera.flashtap.app'];

if (!token) {
  console.error('CLOUDFLARE_API_TOKEN not set');
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
      console.log(`DELETE ${name} A ${r.content}:`, del.json.success ? 'OK' : JSON.stringify(del.json.errors));
      if (!del.json.success) process.exit(1);
    }
  }

  console.log('\n=== Add worker custom domains ===');
  for (const hostname of hostnames) {
    const add = await cf(`/accounts/${accountId}/workers/domains`, {
      method: 'POST',
      body: JSON.stringify({
        hostname,
        service,
        zone_id: zoneId,
        environment: 'production',
      }),
    });
    console.log(`ADD ${hostname}:`, add.json.success ? 'OK' : JSON.stringify(add.json.errors));
    if (!add.json.success) process.exit(1);
    if (add.json.result) console.log('  cert_id:', add.json.result.cert_id);
  }

  console.log('\n=== Worker custom domains ===');
  const domains = await cf(`/accounts/${accountId}/workers/domains`);
  if (domains.json.success) {
    for (const d of domains.json.result) {
      console.log(d.hostname, '->', d.service, 'enabled=' + d.enabled);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
