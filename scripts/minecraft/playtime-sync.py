#!/usr/bin/env python3
"""Send each player's Minecraft play time to lahtiag.fi, per day.

Runs every five minutes on the host (lahtiag-playtime@<server>.timer) with
the same config file as the whitelist sync (LAHTIAG_WHITELIST_CONF; keys
URL, SERVER, TOKEN, WHITELIST_FILE; optionally STATS_DIR and STATE). It
reads the server's own player statistics, the online ticks per player in
<world>/stats/<uuid>.json (modern "minecraft:play_time", the older
"minecraft:play_one_minute", or the flat 1.7.10 "stat.playOneMinute"),
turns the ticks since the last run into minutes (1200 ticks each, the rest
carried over), attributes them to today in Helsinki time, and posts them
to /api/minecraft/playtime in a batch numbered per host, which the site
applies once. The first run only takes a baseline. State: the last ticks
per player, the carry and the unsent minutes, in
/var/lib/lahtiag-playtime-<server>.json.
"""
import glob
import json
import os
import re
import secrets
import sys
import urllib.error
import urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo

CONFIG = os.environ.get('LAHTIAG_WHITELIST_CONF', '/etc/lahtiag-whitelist-smp.conf')
UA = 'lahtiag-playtime-sync/1 (+https://lahtiag.fi)'
TICKS_PER_MINUTE = 1200
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')


def load_config(path):
    conf = {'URL': 'https://lahtiag.fi/api/minecraft/whitelist', 'SERVER': '', 'STATS_DIR': '', 'STATE': ''}
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
    for key in ('TOKEN', 'WHITELIST_FILE', 'SERVER'):
        if not conf.get(key):
            sys.exit(f'{path}: {key} is missing')
    return conf


def stats_dir(conf):
    """The folder with one JSON per player: given, or found next to the whitelist."""
    if conf['STATS_DIR']:
        return conf['STATS_DIR'] if os.path.isdir(conf['STATS_DIR']) else None
    base = os.path.dirname(conf['WHITELIST_FILE'])
    level = 'world'
    try:
        with open(os.path.join(base, 'server.properties')) as f:
            for line in f:
                if line.startswith('level-name='):
                    level = line.split('=', 1)[1].strip() or level
    except OSError:
        pass
    for candidate in (f'{base}/{level}/stats', f'{base}/{level}/players/stats', f'{base}/world/stats', f'{base}/world/players/stats'):
        if os.path.isdir(candidate):
            return candidate
    return None


def read_ticks(path):
    with open(path) as f:
        data = json.load(f)
    if isinstance(data.get('stats'), dict):
        custom = data['stats'].get('minecraft:custom') or {}
        value = custom.get('minecraft:play_time', custom.get('minecraft:play_one_minute'))
    else:
        value = data.get('stat.playOneMinute')
    if isinstance(value, dict):
        value = value.get('value')
    return int(value) if isinstance(value, (int, float)) else None


def load_state(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {'instance': secrets.token_hex(8), 'seq': 1, 'ticks': {}, 'carry': {}, 'pending': {}}


def save_state(path, state):
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(state, f)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def push(conf, state):
    rows = [{'uuid': key.split('|')[0], 'day': key.split('|')[1], 'minutes': minutes} for key, minutes in state['pending'].items() if minutes > 0]
    if not rows:
        return 0
    url = conf['URL'].replace('/api/minecraft/whitelist', '/api/minecraft/playtime')
    body = json.dumps({'instance': state['instance'], 'seq': state['seq'], 'server': conf['SERVER'], 'deltas': rows}).encode()
    req = urllib.request.Request(url, data=body, method='POST', headers={'Authorization': f"Bearer {conf['TOKEN']}", 'Content-Type': 'application/json', 'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=20) as r:
        answer = json.load(r)
    if not answer.get('ok'):
        raise ValueError(f'the site answered {answer}')
    for row in rows:
        key = f"{row['uuid']}|{row['day']}"
        state['pending'][key] -= row['minutes']
        if state['pending'][key] <= 0:
            del state['pending'][key]
    state['seq'] += 1
    return len(rows)


def main():
    conf = load_config(CONFIG)
    folder = stats_dir(conf)
    if not folder:
        print(f"no player statistics folder found next to {conf['WHITELIST_FILE']}; set STATS_DIR=")
        return 0
    state_path = conf['STATE'] or f"/var/lib/lahtiag-playtime-{conf['SERVER']}.json"
    state = load_state(state_path)
    today = datetime.now(ZoneInfo('Europe/Helsinki')).strftime('%Y-%m-%d')
    sampled = baselined = 0
    for path in glob.glob(os.path.join(folder, '*.json')):
        uuid = os.path.basename(path)[:-5].lower()
        if not UUID.match(uuid):
            continue
        try:
            ticks = read_ticks(path)
        except (OSError, ValueError):
            continue
        if ticks is None:
            continue
        sampled += 1
        last = state['ticks'].get(uuid)
        state['ticks'][uuid] = ticks
        if last is None:
            baselined += 1
            continue
        delta = ticks - last
        if delta < 0:  # the statistics were reset; count what is there
            delta = ticks
        carry = state['carry'].get(uuid, 0) + delta
        minutes = carry // TICKS_PER_MINUTE
        state['carry'][uuid] = carry - minutes * TICKS_PER_MINUTE
        if minutes > 0:
            key = f'{uuid}|{today}'
            state['pending'][key] = state['pending'].get(key, 0) + minutes
    try:
        sent = push(conf, state)
        problem = None
    except (urllib.error.URLError, ValueError, OSError) as e:
        sent = 0
        problem = e
    save_state(state_path, state)
    waiting = sum(state['pending'].values())
    print(f"{conf['SERVER']}: {sampled} players sampled, {baselined} new baselines, {sent} rows sent" + (f', {waiting} minutes waiting' if waiting else ''))
    if problem:
        print(f'the site could not be reached, will retry: {problem}')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
