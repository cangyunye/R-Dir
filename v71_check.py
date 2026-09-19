data = open(r'cmp\v71\R-Dir.app\Contents\MacOS\R-Dir', 'rb').read()
print('v0.7.1 binary size: %d bytes' % len(data))
for t in ['russh', 'sftp_', 'sftp://', 'ureq', 'http_autoindex', 'axum', 'share://', 'wry']:
    print('  %-16s %s' % (t, 'Y' if t.encode() in data else '-'))
