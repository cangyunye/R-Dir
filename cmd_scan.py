import re
for p, tag in [('ci65.log','v0.6.5'), ('ci70.log','v0.7.0')]:
    data = open(p, encoding='utf-8', errors='replace').read()
    print('===', tag, '===')
    # 找 cargo build / tauri 命令
    for m in re.finditer(r'[^\n]*(?:cargo (?:build|tauri)|tauri build|--no-default-features|--features)[^\n]*', data):
        line = re.sub(r'\x1b\[[0-9;]*m', '', m.group(0)).strip()
        if len(line) > 5:
            print(' ', line[:160])
