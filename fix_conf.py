import json
# tauri.conf.json: beforeDevCommand / beforeBuildCommand 切 pnpm
p = 'src-tauri/tauri.conf.json'
d = json.load(open(p, encoding='utf-8'))
d['build']['beforeDevCommand'] = 'pnpm dev'
d['build']['beforeBuildCommand'] = 'pnpm build'
json.dump(d, open(p, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
print('tauri.conf.json build 命令:', d['build'])
