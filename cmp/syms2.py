targets = ['ssh2', 'libssh2', 'sftp_', 'ssh_', 'russh', 'ureq', 'http_autoindex', 'curl', 'openssl', 'apple_silicone', 'share://', 'sftp://', 'http://', 'localhost:8082']
for d in ['v65', 'v70']:
    exe = d + r'\R-Dir.app\Contents\MacOS\R-Dir'
    data = open(exe, 'rb').read()
    print('===', d, '===')
    for t in targets:
        print('  %-18s %s' % (t, 'Y' if t.encode() in data else '-'))
