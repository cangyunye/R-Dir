import re, json
d = json.load(open('package.json', encoding='utf-8'))
d['version'] = '0.7.2'
json.dump(d, open('package.json', 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
p = 'src-tauri/Cargo.toml'
s = open(p, encoding='utf-8').read()
s = s.replace('name = "rust-file-manager"\nversion = "0.7.1"', 'name = "rust-file-manager"\nversion = "0.7.2"', 1)
open(p, 'w', encoding='utf-8').write(s)
p = 'src-tauri/Cargo.lock'
s = open(p, encoding='utf-8').read()
m = re.search(r'name = "rust-file-manager"\nversion = "[^"]+"', s)
s = s.replace(m.group(0), 'name = "rust-file-manager"\nversion = "0.7.2"', 1)
open(p, 'w', encoding='utf-8').write(s)
d = json.load(open('src-tauri/tauri.conf.json', encoding='utf-8'))
d['version'] = '0.7.2'
json.dump(d, open('src-tauri/tauri.conf.json', 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
p = 'src/components/MenuBar.tsx'
s = open(p, encoding='utf-8').read()
s = s.replace('版本 0.7.1（Tauri 2 + React）', '版本 0.7.2（Tauri 2 + React）')
open(p, 'w', encoding='utf-8').write(s)
print('bumped to 0.7.2')
