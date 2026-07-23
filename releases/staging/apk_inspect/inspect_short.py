import re

data = open("assets/index.android.bundle", "rb").read()

def show(label, needle, width=60):
    idx = data.find(needle)
    n = 0
    while idx != -1:
        n += 1
        start = max(0, idx - 20)
        end = min(len(data), idx + len(needle) + 20)
        snippet = data[start:end]
        printable = "".join(chr(b) if 32 <= b < 127 else "|" for b in snippet)
        print(f"{label} #{n} @ {idx}: {printable}")
        idx = data.find(needle, idx + 1)
    if n == 0:
        print(f"{label}: NOT FOUND")

show("flashtap.app URL", b"https://www.flashtap.app")
show("prod supabase", b"ihlmmpmolnpchzgwyhgh")
show("staging workers", b"llosperofficial")
show("NOT SET", b"NOT SET")

# Hermes string table: find isolated URL literals only
print("\nIsolated URL literals containing flashtap:")
for m in re.finditer(rb"(?<![a-zA-Z0-9._-])https?://[a-zA-Z0-9][a-zA-Z0-9._/-]*flashtap[a-zA-Z0-9._/-]*(?![a-zA-Z0-9._-])", data):
    print(" ", m.group(0).decode())
