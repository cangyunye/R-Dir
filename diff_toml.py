import re
def parse(p):
    return open(p, encoding='utf-8').read()
a = parse('c65.toml'); b = parse('c70.toml')
print('=== versions ===')
print('v0.6.5:', re.search(r'version = \"([^\"]+)\"', a).group(1), '| v0.7.0:', re.search(r'version = \"([^\"]+)\"', b).group(1))
print('=== default features ===')
print('v0.6.5:', re.search(r'default = \[([^\]]+)\]', a).group(1))
print('v0.7.0:', re.search(r'default = \[([^\]]+)\]', b).group(1))
print('=== deps diff (line-level) ===')
import difflib
da = a.splitlines(); db = b.splitlines()
sm = difflib.SequenceMatcher(None, da, db)
for op, i1, i2, j1, j2 in sm.get_opcodes():
    if op != 'equal':
        for l in da[i1:i2]: print('  -', l.strip())
        for l in db[j1:j2]: print('  +', l.strip())
