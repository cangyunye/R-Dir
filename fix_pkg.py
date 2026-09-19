import json
p = 'package.json'
d = json.load(open(p, encoding='utf-8'))
# 移除误加的 pnpm 运行时依赖
deps = d.get('dependencies', {})
if 'pnpm' in deps:
    del deps['pnpm']
    print('移除 dependencies.pnpm')
# 添加 packageManager 字段（corepack/pnpm 版本声明）
d['packageManager'] = 'pnpm@12.4.2'
json.dump(d, open(p, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
print('packageManager =', d['packageManager'])
print('version =', d['version'])
