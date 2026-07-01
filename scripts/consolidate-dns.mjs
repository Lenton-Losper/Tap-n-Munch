#!/usr/bin/env node
const dnsToken = process.env.CLOUDFLARE_DNS_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
const workersToken = process.env.CLOUDFLARE_WORKERS_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || 'b74d9cfb3ba0e345287429ca237ecbfd';
const zoneId = '9fce22c09d6c7ac737d7d53d250c3e72';
const service = 'flashtap-production';
const hostnames = ['www.flashtap.app', 'riviera.flashtap.app'];

if (!dnsToken || !workersToken) {
  console.error('CLOUDFLARE_DNS_TOKEN and CLOUDFLARE_WORKERS_TOKEN required');
  process.exit(1);
}

async function cf(token, path, opts = {}) {
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
  console.log('=== Step 1: DNS records (www + riviera + apex) ===');
  const dns = await cf(dnsToken, `/zones/${zoneId}/dns_records?per_page=100`);
  if (!dns.json.success) {
    console.log('DNS list failed:', JSON.stringify(dns.json.errors));
    console.log('(continuing — worker custom domain API may manage DNS automatically)');
  } else {
    for (const r of dns.json.result) {
      if (['www.flashtap.app', 'riviera.flashtap.app', 'flashtap.app'].includes(r.name)) {
        console.log(`${r.type}\t${r.name}\t${r.content}\tproxied=${r.proxied}\tid=${r.id}`);
      }
    }

    console.log('\n=== Delete conflicting A records ===');
    for (const name of hostnames) {
      const records = dns.json.result.filter((r) => r.name === name && r.type === 'A');
      for (const r of records) {
        const del = await cf(dnsToken, `/zones/${zoneId}/dns_records/${r.id}`, { method: 'DELETE' });
        console.log(`DELETE ${name} A ${r.content}:`, del.json.success ? 'OK' : JSON.stringify(del.json.errors));
        if (!del.json.success) process.exit(1);
      }
      if (records.length === 0) console.log(`No A records for ${name} (may already be on worker routing)`);
    }
  }

  console.log('\n=== Add worker custom domains ===');
  for (const hostname of hostnames) {
    const add = await cf(workersToken, `/accounts/${accountId}/workers/domains`, {
      method: 'POST',
      body: JSON.stringify({
        hostname,
        service,
        zone_id: zoneId,
        environment: 'production',
      }),
    });
    if (add.json.success) {
      console.log(`ADD ${hostname}: OK cert_id=${add.json.result?.cert_id || 'n/a'}`);
    } else {
      const msg = JSON.stringify(add.json.errors);
      if (msg.includes('already exists') || msg.includes('1061')) {
        console.log(`ADD ${hostname}: already exists — OK`);
      } else {
        console.log(`ADD ${hostname}: FAILED`, msg);
        process.exit(1);
      }
    }
  }

  console.log('\n=== Worker custom domains ===');
  const domains = await cf(workersToken, `/accounts/${accountId}/workers/domains`);
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
