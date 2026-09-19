import re, json
# package.json
d = json.load(open('package.json', encoding='utf-8'))
assert d['version'] == '0.7.0', d['version']
d['version'] = '0.7.1'
json.dump(d, open('package.json', 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
# Cargo.toml
p = 'src-tauri/Cargo.toml'
s = open(p, encoding='utf-8').read()
s = s.replace('name = "rust-file-manager"\nversion = "0.7.0"', 'name = "rust-file-manager"\nversion = "0.7.1"', 1)
open(p, 'w', encoding='utf-8').write(s)
# Cargo.lock
p = 'src-tauri/Cargo.lock'
s = open(p, encoding='utf-8').read()
m = re.search(r'name = "rust-file-manager"\nversion = "[^"]+"', s)
s = s.replace(m.group(0), 'name = "rust-file-manager"\nversion = "0.7.1"', 1)
open(p, 'w', encoding='utf-8').write(s)
# tauri.conf.json
d = json.load(open('src-tauri/tauri.conf.json', encoding='utf-8'))
assert d['version'] == '0.7.0'
d['version'] = '0.7.1'
json.dump(d, open('src-tauri/tauri.conf.json', 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
# MenuBar.tsx
p = 'src/components/MenuBar.tsx'
s = open(p, encoding='utf-8').read()
old = '版本 0.7.0（Tauri 2 + React）'
assert s.count(old) == 1
s = s.replace(old, '版本 0.7.1（Tauri 2 + React）')
open(p, 'w', encoding='utf-8').write(s)
print('version bumped to 0.7.1 (5 places)')
