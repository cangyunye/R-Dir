import re
for p, tag in [('ci65.log','v0.6.5'), ('ci70.log','v0.7.0')]:
    data = open(p, encoding='utf-8', errors='replace').read()
    lines = re.findall(r'Compiling\s+([\w-]+)\s+v[\d.]+', data)
    print('===', tag, '=== Compiling 行数:', len(lines))
    from collections import Counter
    c = Counter(lines)
    for name, n in c.most_common(20):
        print('  %-22s x%d' % (name, n))
