import re

data = open("assets/index.android.bundle", "rb").read()
strings = re.findall(rb"[\x20-\x7e]{4,}", data)

print("=== strings-like lines matching flashtap|staging|workers.dev (first 30) ===")
count = 0
for s in strings:
    text = s.decode("ascii")
    low = text.lower()
    if any(k in low for k in ("flashtap", "staging", "workers.dev")):
        if "http" in low or "flashtap" in low:
            print(text[:200] + ("..." if len(text) > 200 else ""))
            count += 1
            if count >= 30:
                break

print("\n=== Distinct http URLs in bundle (any host, deduped) ===")
all_urls = set()
for m in re.finditer(rb"https?://[a-zA-Z0-9][a-zA-Z0-9._/-]{2,80}", data):
    u = m.group(0).decode()
    if "flashtap" in u.lower():
        all_urls.add(u)
for u in sorted(all_urls):
    print(u)
