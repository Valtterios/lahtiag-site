#!/usr/bin/env python3
"""Keep an AMP-managed Minecraft server's whitelist equal to the list on
lahtiag.fi. Runs from lahtiag-whitelist.timer every few minutes; see
docs/OPERATIONS.md, "The Minecraft whitelist".

The site is the source of truth (members' own names, their friends, and
names the board added). This script fetches it and reads the server's own
whitelist.json to see what is there now. For the difference:

  - a running server gets "whitelist add" and "whitelist remove" console
    commands through the instance's AMP API (needs AMP_USER and AMP_PASS);
  - a stopped or sleeping server, or one without AMP credentials, gets
    whitelist.json rewritten directly (UUIDs looked up at Mojang), which
    the server reads when it next starts.

Nothing happens when the fetch fails, names in KEEP are never removed, and
REMOVE=no makes it add-only, so a bad day on the site cannot empty the
list.

Config file, KEY=value lines, one per server (LAHTIAG_WHITELIST_CONF, default
/etc/lahtiag-whitelist-smp.conf; the lahtiag-whitelist@<server> units set it):

  URL=https://lahtiag.fi/api/minecraft/whitelist
  SERVER=smp                      this server's slug on the site (see SERVERS
                                  in src/lib/minecraft.ts); empty = every name
  TOKEN=...                       the site's MINECRAFT_WHITELIST_TOKEN secret
  WHITELIST_FILE=/mnt/storage/amp-instances/LahtiAG02/Minecraft/whitelist.json
  AMP_URL=http://127.0.0.1:8081   the instance's own AMP endpoint on this host
  AMP_USER=whitelist              an AMP user with console access to it (optional)
  AMP_PASS=...
  CONTAINER=AMP_LahtiAG02         the instance's Docker container, to tell a
                                  running server apart without AMP credentials
  KEEP=Axinikk                    comma-separated, never removed
  REMOVE=yes                      no = only ever add names
"""

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

CONFIG = os.environ.get('LAHTIAG_WHITELIST_CONF', '/etc/lahtiag-whitelist-smp.conf')
AMP_READY = 20  # AMP's ApplicationState.Ready: the game server is up
AMP_BUSY = {5, 7, 10, 30, 40, 45}  # starting, stopping, restarting: try again next run


def load_config(path):
    conf = {'REMOVE': 'yes', 'KEEP': '', 'URL': 'https://lahtiag.fi/api/minecraft/whitelist', 'SERVER': '', 'AMP_URL': '', 'AMP_USER': '', 'AMP_PASS': '', 'CONTAINER': ''}
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
    for key in ('TOKEN', 'WHITELIST_FILE'):
        if not conf.get(key):
            sys.exit(f'{path}: {key} is missing')
    return conf


# A named User-Agent: Cloudflare's bot rules turn away the bare Python one.
UA = 'lahtiag-whitelist-sync/1 (+https://lahtiag.fi)'


def fetch_wanted(conf):
    url = conf['URL'] + (('&' if '?' in conf['URL'] else '?') + 'server=' + conf['SERVER'] if conf['SERVER'] else '')
    req = urllib.request.Request(url, headers={'Authorization': f"Bearer {conf['TOKEN']}", 'Accept': 'application/json', 'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=20) as r:
        data = json.load(r)
    players = data.get('players')
    if not isinstance(players, list) or not all(isinstance(p, dict) and isinstance(p.get('name'), str) for p in players):
        raise ValueError('the site answered without a players list')
    # name -> the site's UUID for it (None for a name from before the lookup)
    return {p['name']: (p.get('uuid') or None) for p in players}


def read_entries(path):
    try:
        with open(path) as f:
            entries = json.load(f)
    except FileNotFoundError:
        return []
    return [e for e in entries if isinstance(e, dict) and isinstance(e.get('name'), str)]


def container_running(name):
    if not name:
        return None
    try:
        out = subprocess.run(['docker', 'inspect', '-f', '{{.State.Running}}', name], capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return out.returncode == 0 and out.stdout.strip() == 'true'


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
            raise PermissionError(f"AMP login failed: {answer.get('resultReason') or answer}")
        self.session = answer['sessionID']

    def state(self):
        return int(self.call('Core/GetStatus', {'SESSIONID': self.session}).get('State', -1))

    def console(self, message):
        self.call('Core/SendConsoleMessage', {'SESSIONID': self.session, 'message': message})

    def logout(self):
        if self.session:
            try:
                self.call('Core/Logout', {'SESSIONID': self.session})
            except Exception:
                pass


def mojang_uuid(name):
    """The dashed UUID of a Java edition name, or None for an unknown name."""
    req = urllib.request.Request(f'https://api.mojang.com/users/profiles/minecraft/{name}', headers={'Accept': 'application/json', 'User-Agent': UA})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        if e.code in (204, 404):
            return None, None
        raise
    raw = data.get('id', '')
    if len(raw) != 32:
        return None, None
    return f'{raw[0:8]}-{raw[8:12]}-{raw[12:16]}-{raw[16:20]}-{raw[20:32]}', data.get('name', name)


def write_file(path, entries, adds, removes, uuids):
    gone = {n.lower() for n in removes}
    kept = [e for e in entries if e['name'].lower() not in gone]
    unknown = []
    for name in adds:
        uuid, exact = (uuids.get(name), name) if uuids.get(name) else mojang_uuid(name)
        if not uuid:
            unknown.append(name)
            continue
        kept.append({'uuid': uuid, 'name': exact})
    tmp = f'{path}.lahtiag-tmp'
    with open(tmp, 'w') as f:
        json.dump(kept, f, indent=2)
        f.write('\n')
    try:
        st = os.stat(path)
        os.chown(tmp, st.st_uid, st.st_gid)
        os.chmod(tmp, st.st_mode & 0o777)
    except FileNotFoundError:
        pass
    os.replace(tmp, path)
    return unknown


def main():
    conf = load_config(CONFIG)
    keep = {n.strip() for n in conf['KEEP'].split(',') if n.strip()}
    try:
        wanted = fetch_wanted(conf)
    except (urllib.error.URLError, ValueError, json.JSONDecodeError) as e:
        sys.exit(f'whitelist fetch failed, nothing changed: {e}')

    entries = read_entries(conf['WHITELIST_FILE'])
    uuids = dict(wanted)
    wanted_all = {n.lower(): n for n in list(wanted) + list(keep)}
    current = {e['name'].lower(): e['name'] for e in entries}
    adds = [wanted_all[k] for k in sorted(wanted_all) if k not in current]
    removes = []
    if conf['REMOVE'].lower() in ('yes', 'true', '1'):
        removes = [current[k] for k in sorted(current) if k not in wanted_all]
    if not adds and not removes:
        print(f'in sync: {len(current)} names')
        return

    # Which way in: the console of a running server, or its file.
    amp = None
    if conf['AMP_URL'] and conf['AMP_USER'] and conf['AMP_PASS']:
        amp = Amp(conf['AMP_URL'])
        try:
            amp.login(conf['AMP_USER'], conf['AMP_PASS'])
            state = amp.state()
        except urllib.error.URLError:
            amp = None  # the instance is off: no AMP process answers
        except PermissionError as e:
            if container_running(conf['CONTAINER']):
                sys.exit(f'{e}; the server is up, so nothing changed')
            amp = None
        else:
            if state in AMP_BUSY:
                amp.logout()
                print(f'server is changing state ({state}), trying again next run')
                return
            if state != AMP_READY:
                amp.logout()
                amp = None
    elif container_running(conf['CONTAINER']):
        sys.exit('the server is up and AMP_USER/AMP_PASS are not set: nothing changed')

    if amp:
        try:
            for name in adds:
                amp.console(f'whitelist add {name}')
                time.sleep(0.3)
            for name in removes:
                amp.console(f'whitelist remove {name}')
                time.sleep(0.3)
        except urllib.error.URLError as e:
            sys.exit(f'AMP call failed: {e}')
        finally:
            amp.logout()
        print(f"console: +{len(adds)} {' '.join(adds)}  -{len(removes)} {' '.join(removes)}".rstrip())
        # The server writes whitelist.json on each change; a name still
        # missing after a moment is usually not a real Mojang account.
        time.sleep(3)
        after = {e['name'].lower() for e in read_entries(conf['WHITELIST_FILE'])}
        missing = [n for n in adds if n.lower() not in after]
        lingering = [n for n in removes if n.lower() in after]
        if missing or lingering:
            print(f'not applied yet: missing {missing} still there {lingering}')
        return

    try:
        unknown = write_file(conf['WHITELIST_FILE'], entries, adds, removes, uuids)
    except (OSError, urllib.error.URLError) as e:
        sys.exit(f'writing whitelist.json failed: {e}')
    added = [n for n in adds if n not in unknown]
    print(f"file (server off): +{len(added)} {' '.join(added)}  -{len(removes)} {' '.join(removes)}".rstrip())
    if unknown:
        print(f'unknown at Mojang, skipped: {unknown}')


if __name__ == '__main__':
    main()
