import re
def crates(p):
    names = set()
    for m in re.finditer(r'name = \"([^\"]+)\"\nversion = \"([^\"]+)\"', open(p, encoding='utf-8').read()):
        names.add(m.group(1))
    return names
a = crates('l65.lock'); b = crates('l70.lock')
print('v0.6.5 crates:', len(a), '| v0.7.0 crates:', len(b))
print('v0.6.5 有而 v0.7.0 无:', sorted(a - b))
print('v0.7.0 新增:', sorted(b - a))
for k in ('ureq', 'axum', 'hyper', 'tower', 'local-ip-address', 'futures-util'):
    print(' ', k, '->', k in a, '/', k in b)
