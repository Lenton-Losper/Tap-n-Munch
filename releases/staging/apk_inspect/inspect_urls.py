import re

path = r"assets\index.android.bundle"
with open(path, "rb") as f:
    data = f.read()

print("=== Byte counts for known substrings ===")
needles = [
    b"https://www.flashtap.app",
    b"www.flashtap.app",
    b"flashtap-staging",
    b"workers.dev",
    b"flashtap.app/",
    b"ENV_NAME",
    b"staging",
]
for n in needles:
    print(f"  {n.decode(errors='replace')!r}: {data.count(n)}")

print("\n=== Printable strings containing 'flashtap' and 'http' ===")
strings = re.findall(rb"[\x20-\x7e]{6,}", data)
seen = set()
for s in strings:
    text = s.decode("ascii")
    if "flashtap" in text.lower() and "http" in text.lower():
        seen.add(text)
for t in sorted(seen):
    print(t)

print("\n=== Strict URL regex (flashtap in host/path) ===")
urls = set()
for m in re.finditer(
    rb"https?://[a-zA-Z0-9][a-zA-Z0-9._-]*flashtap[a-zA-Z0-9._/-]*", data
):
    urls.add(m.group(0).decode())
for u in sorted(urls):
    print(u)

print("\n=== Context around https://www.flashtap.app ===")
needle = b"https://www.flashtap.app"
idx = data.find(needle)
while idx != -1:
    start = max(0, idx - 40)
    end = min(len(data), idx + len(needle) + 40)
    snippet = data[start:end]
    printable = "".join(chr(b) if 32 <= b < 127 else "." for b in snippet)
    print(f"  offset {idx}: ...{printable}...")
    idx = data.find(needle, idx + 1)

print("\n=== All unique flashtap-related host fragments (>= 8 chars) ===")
hosts = set(
    h.decode()
    for h in re.findall(rb"[a-zA-Z0-9][a-zA-Z0-9._-]{6,}flashtap[a-zA-Z0-9._-]*", data)
)
for h in sorted(hosts):
    print(h)
