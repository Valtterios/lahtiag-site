#!/usr/bin/env python3
"""Keep an AMP-managed Minecraft server's whitelist equal to the list on
lahtiag.fi. Runs from lahtiag-whitelist.timer every few minutes; see
docs/OPERATIONS.md, "The Minecraft whitelist".

The site is the source of truth (members' own names, their friends, and
names the board added). This script fetches it, reads the server's own
whitelist.json to see what is there now, and sends "whitelist add" and
"whitelist remove" console commands through the instance's AMP API for the
difference. Nothing happens when the fetch fails, and names in KEEP are
never removed, so a bad day on the site cannot empty the list.

Config file, KEY=value lines (default /etc/lahtiag-whitelist.conf):

  URL=https://lahtiag.fi/api/minecraft/whitelist
  TOKEN=...                       the site's MINECRAFT_WHITELIST_TOKEN secret
  AMP_URL=http://127.0.0.1:8091   the instance's own AMP endpoint on this host
  AMP_USER=whitelist              an AMP user with console access to it
  AMP_PASS=...
  WHITELIST_FILE=/mnt/storage/amp-instances/LahtiAG02/Minecraft/whitelist.json
  KEEP=Axinikk                    comma-separated, never removed
  REMOVE=yes                      no = only ever add names
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

CONFIG = os.environ.get('LAHTIAG_WHITELIST_CONF', '/etc/lahtiag-whitelist.conf')


def load_config(path):
    conf = {'REMOVE': 'yes', 'KEEP': '', 'URL': 'https://lahtiag.fi/api/minecraft/whitelist'}
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                key, value = line.split('=', 1)
                conf[key.strip()] = value.strip()
    except OSError as e:
        sys.exit(f'cannot read {path}: {e}')
    for key in ('TOKEN', 'AMP_URL', 'AMP_USER', 'AMP_PASS', 'WHITELIST_FILE'):
        if not conf.get(key):
            sys.exit(f'{path}: {key} is missing')
    return conf


def fetch_wanted(conf):
    req = urllib.request.Request(conf['URL'], headers={'Authorization': f"Bearer {conf['TOKEN']}", 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=20) as r:
        data = json.load(r)
    names = data.get('names')
    if not isinstance(names, list) or not all(isinstance(n, str) for n in names):
        raise ValueError('the site answered without a names list')
    return names


def read_current(path):
    try:
        with open(path) as f:
            entries = json.load(f)
    except FileNotFoundError:
        return []
    return [e['name'] for e in entries if isinstance(e, dict) and isinstance(e.get('name'), str)]


class Amp:
    def __init__(self, base):
        self.base = base.rstrip('/')
        self.session = None

    def call(self, endpoint, payload):
        req = urllib.request.Request(
            f'{self.base}/API/{endpoint}',
            data=json.dumps(payload).encode(),
            headers={'Content-Type': 'application/json', 'Accept': 'application/json'},
        )
        with urllib.request.urlopen(req, timeout=20) as r:
            body = r.read()
        return json.loads(body) if body else {}

    def login(self, user, password):
        answer = self.call('Core/Login', {'username': user, 'password': password, 'token': '', 'rememberMe': False})
        if not answer.get('success') or not answer.get('sessionID'):
            raise RuntimeError(f"AMP login failed: {answer.get('resultReason') or answer}")
        self.session = answer['sessionID']

    def console(self, message):
        self.call('Core/SendConsoleMessage', {'SESSIONID': self.session, 'message': message})

    def logout(self):
        if self.session:
            try:
                self.call('Core/Logout', {'SESSIONID': self.session})
            except Exception:
                pass


def main():
    conf = load_config(CONFIG)
    keep = {n.strip() for n in conf['KEEP'].split(',') if n.strip()}
    try:
        wanted = fetch_wanted(conf)
    except (urllib.error.URLError, ValueError, json.JSONDecodeError) as e:
        sys.exit(f'whitelist fetch failed, nothing changed: {e}')

    wanted_all = {n.lower(): n for n in list(wanted) + list(keep)}
    current = {n.lower(): n for n in read_current(conf['WHITELIST_FILE'])}
    adds = [wanted_all[k] for k in sorted(wanted_all) if k not in current]
    removes = []
    if conf['REMOVE'].lower() in ('yes', 'true', '1'):
        removes = [current[k] for k in sorted(current) if k not in wanted_all]
    if not adds and not removes:
        print(f'in sync: {len(current)} names')
        return

    amp = Amp(conf['AMP_URL'])
    try:
        amp.login(conf['AMP_USER'], conf['AMP_PASS'])
        for name in adds:
            amp.console(f'whitelist add {name}')
            time.sleep(0.3)
        for name in removes:
            amp.console(f'whitelist remove {name}')
            time.sleep(0.3)
    except (urllib.error.URLError, RuntimeError) as e:
        sys.exit(f'AMP call failed: {e}')
    finally:
        amp.logout()
    print(f"sent: +{len(adds)} {' '.join(adds)}  -{len(removes)} {' '.join(removes)}".rstrip())

    # The server writes whitelist.json on each change; a name still
    # missing after a moment usually means an unknown Mojang name, or a
    # server that is off or asleep (then the next run tries again).
    time.sleep(3)
    after = {n.lower() for n in read_current(conf['WHITELIST_FILE'])}
    missing = [n for n in adds if n.lower() not in after]
    lingering = [n for n in removes if n.lower() in after]
    if missing or lingering:
        print(f"not applied yet: missing {missing} still there {lingering}")


if __name__ == '__main__':
    main()
