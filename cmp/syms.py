import re
targets = ['ureq', 'http_autoindex', 'sftp', 'axum', 'tokio-tungstenite', 'share', 'opener', 'wry', 'webkit2gtk', 'GtkWindow', 'openssl', 'native-tls', 'rustls']
for d in ['v65', 'v70']:
    exe = d + r'\R-Dir.app\Contents\MacOS\R-Dir'
    data = open(exe, 'rb').read()
    print('===', d, '===')
    for t in targets:
        print('  %-18s %s' % (t, 'Y' if t.encode() in data else '-'))
