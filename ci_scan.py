import re
for p, tag in [('ci65.log','v0.6.5'), ('ci70.log','v0.7.0')]:
    data = open(p, encoding='utf-8', errors='replace').read()
    print('===', tag, '===')
    for crate in ['russh', 'ureq', 'axum', 'share', 'ssh2', 'aes-gcm', 'tokio']:
        c = len(re.findall(r'Compiling\s+' + crate + r' v', data))
        print('  Compiling %-10s x%d' % (crate, c))
