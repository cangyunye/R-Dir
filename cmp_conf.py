import json
for p, tag in [('t65.json','v0.6.5'), ('t70.json','v0.7.0')]:
    d = json.load(open(p, encoding='utf-8-sig'))
    print('===', tag, '===')
    print('version:', d.get('version'))
    print('build:', json.dumps(d.get('build', {}), ensure_ascii=False))
    print('bundle:', json.dumps({k: d.get('bundle', {}).get(k) for k in ('active','targets','category')}, ensure_ascii=False))
