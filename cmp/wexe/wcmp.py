data = {}
for tag in ['0.6.5', '0.7.0']:
    p = 'R-Dir_%s_x64-setup.exe' % tag
    data[tag] = open(p, 'rb').read()
print('=== Windows exe 符号对比 ===')
for t in ['russh', 'sftp_', 'sftp://', 'ureq', 'http_autoindex', 'axum', 'share', 'flate2', 'ssh']:
    print('  %-16s v0.6.5=%s  v0.7.0=%s' % (t, 'Y' if t.encode() in data['0.6.5'] else '-', 'Y' if t.encode() in data['0.7.0'] else '-'))
