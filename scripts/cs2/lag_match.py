#!/usr/bin/env python3
"""lag_match — safe administration of the LahtiAG CS2 (MatchZy) tournament servers.

Stdlib only.  Runs on the operator's laptop and shells out over ssh to the AMP
host, using the existing ``/usr/local/bin/cs2 <1|2> "<cmd>"`` RCON helper.

Why this tool exists (all verified from tournament logs, not guesses):

  1. ``matchzy_loadmatch`` SILENTLY DESTROYS a live match if that match was
     autostarted (players readied up with no config loaded).  MatchZy only
     refuses the load when the live match itself came from a config.
  2. MatchZy's ``css_restore <round>`` frequently silently does nothing.  The
     engine command ``mp_backup_restore_load_file <file>.txt`` works.
  3. MatchZy kicks every connected player who is missing from a roster
     (``KICKING PLAYER ... (NOT ALLOWED!)``).  So a PARTIAL roster kicks the
     players it forgot, and one empty roster next to a full one kicks that
     whole team.  Two EMPTY rosters kick nobody and are the preferred mode.
  4. ``css_whitelist`` is a TOGGLE and ignores its argument.  Read the reply
     text ("Enabled"/"Disabled"); never assume.
  5. A stale team->side mapping (e.g. after halftime) makes MatchZy drag players
     to the wrong side continuously.  team1 is CT at match start.
  6. With no match config loaded MatchZy re-execs warmup.cfg repeatedly, which
     resets mp_startmoney to 16000 and mp_starting_losses to 1.
  7. ``matchid`` must be an integer string; a word fails.
  8. Between maps there is a ~2 minute tvFlushDelay (from tv_delay 105).  It
     looks stuck.  It is not.
  9. ``bot_quota_mode fill`` tops the SERVER up to a total head count and lets
     the engine pick the side.  With ``mp_limitteams 0`` (every competitive
     config sets it) nothing stops it choosing the team that is already
     bigger: in a real bo3 Turbiini lost a player and the bot joined heat,
     making it 6v4.  Bots must be placed explicitly, per side.

Everything above is encoded as a refusal, a validation or a printed warning.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
import urllib.error
import urllib.request
import time
from datetime import datetime, timezone

# --------------------------------------------------------------------------
# Constants / environment description
# --------------------------------------------------------------------------

# Where the AMP host is and how to authenticate to it.  Both are environment
# variables so the tool can be published and so a second operator does not have
# to edit the source: LAG_SSH_HOST=root@amp.example.org lag_match.py status
SSH_HOST = os.environ.get("LAG_SSH_HOST", "root@your-amp-host")
SSH_IDENTITY_AGENT = os.environ.get("LAG_SSH_IDENTITY_AGENT", "/tmp/aura-agent.sock")

STEAM_BASE = 76561197960265728

SERVERS = {
    "1": {
        "instance": "LahtiAG01",
        "game_port": 27015,
        "gotv_port": 27020,
    },
    "2": {
        "instance": "LahtiAG201",
        "game_port": 27016,
        "gotv_port": 27021,
    },
}

AMP_ROOT = "/mnt/storage/amp-instances"

# CS2 Active Duty, as of the January 2026 update that swapped Train out for
# Anubis. Valve rotates this roughly every six months, so check it before an
# event rather than trusting this list: a stale pool means teams veto maps
# they have not been practising.
DEFAULT_MAPPOOL = [
    "de_ancient",
    "de_anubis",
    "de_dust2",
    "de_inferno",
    "de_mirage",
    "de_nuke",
    "de_overpass",
]

HOME_ENV = "LAG_MATCH_HOME"


def home_dir() -> str:
    return os.environ.get(HOME_ENV) or os.path.expanduser("~/.lag_match")


def registry_path() -> str:
    return os.path.join(home_dir(), "registry.json")


def snapshots_dir() -> str:
    return os.path.join(home_dir(), "snapshots")


def instance_dir(server: str) -> str:
    return "%s/%s" % (AMP_ROOT, SERVERS[server]["instance"])


def csgo_dir(server: str) -> str:
    return instance_dir(server) + "/counter-strike2/730/game/csgo"


def amp_logs_glob(server: str) -> str:
    return instance_dir(server) + "/AMP_Logs/*.log"


# ==========================================================================
# PURE LOGIC  (no I/O — everything below here is unit tested)
# ==========================================================================

# ---- SteamID ------------------------------------------------------------

STEAM3_RE = re.compile(r"\[U:1:(\d+)\]")


def steamid64_from_accountid(accountid) -> str:
    """76561197960265728 + accountid, as a string."""
    acct = int(accountid)
    if acct < 0:
        raise ValueError("accountid must be >= 0")
    return str(STEAM_BASE + acct)


def steamid64_from_steam3(steam3: str) -> str:
    """'[U:1:123]' (or a bare accountid, or an already-64 id) -> SteamID64."""
    s = steam3.strip()
    m = STEAM3_RE.search(s)
    if m:
        return steamid64_from_accountid(m.group(1))
    if s.isdigit():
        if len(s) >= 17:
            return s
        return steamid64_from_accountid(s)
    raise ValueError("unrecognised steam id: %r" % steam3)


# Individual SteamID64s are STEAM_BASE + a 32-bit account id.  Validate by that
# range, never by a literal "7656119" prefix: the account id space is already
# past 2_000_000_000 and ids starting 765612xx are legitimate.
STEAMID64_MIN = STEAM_BASE
STEAMID64_MAX = STEAM_BASE + (2 ** 32 - 1)


def is_valid_steamid64(value: str) -> bool:
    s = str(value).strip()
    if not re.fullmatch(r"[0-9]+", s):
        return False
    return STEAMID64_MIN <= int(s) <= STEAMID64_MAX


# ---- Log parsing --------------------------------------------------------

LOG_TS_RE = re.compile(r"\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]")

# "Name<3><[U:1:123456]><CT>"
PLAYER_QUOTE_RE = re.compile(
    r'"(?P<name>[^"<]*)<(?P<userid>\d+)><\[U:1:(?P<acct>\d+)\]>'
    r'<(?P<side>CT|TERRORIST|Unassigned|Spectator|)>'
)

IS_TEAM_READY_RE = re.compile(
    r"\[IsTeamReady\]\s*team:\s*(?P<team>\d+).*?playerCount:\s*(?P<count>\d+)",
    re.IGNORECASE,
)

KICK_RE = re.compile(r"KICKING PLAYER\s+(?P<who>.*?)\s*\(NOT ALLOWED!\)")

RCON_PASSWORD_RE = re.compile(r"\+rcon_password ([a-f0-9]+)")

SIDE_CANON = {
    "CT": "CT",
    "TERRORIST": "T",
    "T": "T",
    "Unassigned": "SPEC",
    "Spectator": "SPEC",
    "": "SPEC",
}


def parse_log_timestamp(line: str):
    """Leading '[YYYY-MM-DD HH:MM:SS]' (UTC) -> aware datetime, else None."""
    m = LOG_TS_RE.search(line)
    if not m:
        return None
    try:
        dt = datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None
    return dt.replace(tzinfo=timezone.utc)


def parse_players_from_log(log_text: str):
    """Scan an AMP log for player identities.

    Returns {steamid64: {"steamid": .., "name": .., "side": .., "last_seen": ..}}
    keeping the LAST occurrence of each player (latest name/side wins).
    """
    out = {}
    last_ts = None
    for line in log_text.splitlines():
        ts = parse_log_timestamp(line)
        if ts is not None:
            last_ts = ts
        for m in PLAYER_QUOTE_RE.finditer(line):
            name = m.group("name")
            if name in ("Console", "World", "GOTV"):
                continue
            acct = m.group("acct")
            if acct == "0":
                continue  # bots / console
            sid = steamid64_from_accountid(acct)
            rec = out.setdefault(sid, {"steamid": sid})
            rec["name"] = name
            rec["side"] = SIDE_CANON.get(m.group("side"), "SPEC")
            if last_ts is not None:
                rec["last_seen"] = last_ts.isoformat()
    return out


def parse_team_ready_lines(log_text: str):
    """Latest [IsTeamReady] playerCount per team -> {1: 5, 2: 4}."""
    out = {}
    for line in log_text.splitlines():
        m = IS_TEAM_READY_RE.search(line)
        if m:
            out[int(m.group("team"))] = int(m.group("count"))
    return out


def parse_kick_lines(log_text: str):
    """Every 'KICKING PLAYER ... (NOT ALLOWED!)' victim, in order."""
    return [m.group("who") for m in KICK_RE.finditer(log_text)]


def parse_rcon_password(log_text: str):
    """The host helper's trick: newest '+rcon_password <hex>' in the AMP log."""
    found = RCON_PASSWORD_RE.findall(log_text)
    return found[-1] if found else None


# ---- `status` output parsing -------------------------------------------

STATUS_MAP_RE = re.compile(r"^\s*(?:map|Map)\s*[:=]\s*(?P<map>\S+)", re.MULTILINE)
STATUS_PLAYERS_RE = re.compile(
    r"players\s*:\s*(?P<humans>\d+)\s+humans?,\s*(?P<bots>\d+)\s+bots?", re.IGNORECASE
)
# Player names at this event contain colons, quotes-adjacent punctuation and
# non-ASCII ("DJ Jörssi™", "zhang et. al", "Lüh Cränk"), so the name field must
# not be delimited by "the first colon".  Prefer the quoted form; otherwise let
# the name run up to the LAST colon that is followed by the steam3 id.
STATUS_ROW_RE = re.compile(
    r'^\s*#?\s*(?P<userid>\d+)\s*:\s*'
    r'(?:"(?P<qname>[^"]*)"|(?P<name>.+?))'
    r'\s*:\s*(?P<rest>[^:]*\[U:1:\d+\].*)$',
    re.MULTILINE,
)


def parse_status(status_text: str):
    """Parse CS2 `status` output.

    Returns dict with map, humans, bots, players[].  Missing pieces are None so
    callers can tell "unknown" from "zero" — important: an unknown player count
    must never be read as "nobody is connected".
    """
    out = {"map": None, "humans": None, "bots": None, "players": []}
    m = STATUS_MAP_RE.search(status_text)
    if m:
        out["map"] = m.group("map")
    m = STATUS_PLAYERS_RE.search(status_text)
    if m:
        out["humans"] = int(m.group("humans"))
        out["bots"] = int(m.group("bots"))
    seen = set()
    for row in STATUS_ROW_RE.finditer(status_text):
        sm = STEAM3_RE.search(row.group("rest"))
        if not sm:
            continue
        sid = steamid64_from_accountid(sm.group(1))
        if sid in seen:
            continue
        seen.add(sid)
        raw_name = row.group("qname")
        if raw_name is None:
            raw_name = row.group("name") or ""
        out["players"].append(
            {
                "userid": int(row.group("userid")),
                "name": raw_name.strip().strip('"'),
                "steamid": sid,
            }
        )
    if out["humans"] is None and out["players"]:
        out["humans"] = len(out["players"])
    return out


# ---- get5/matchzy status parsing ---------------------------------------

def parse_get5_status(text: str):
    """MatchZy answers `get5_status` with JSON.  Anything else -> None.

    Never raise: an unknown command must degrade to "unknown", not to "safe".
    """
    if not text:
        return None
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end < start:
        return None
    try:
        data = json.loads(text[start : end + 1])
    except (ValueError, TypeError):
        return None
    if not isinstance(data, dict):
        return None
    return data


def _first(d, *keys, default=None):
    for k in keys:
        if isinstance(d, dict) and k in d and d[k] is not None:
            return d[k]
    return default


def _to_int(value, default=None):
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return default


def state_from_get5_status(data):
    """Normalise a get5/MatchZy status blob into our own vocabulary."""
    if not data:
        return {}
    gamestate = _first(data, "gamestate", "game_state")
    loaded = _first(data, "matchid", "match_id", "loaded_config_file")
    rounds = _to_int(
        _first(data, "RoundsPlayed", "rounds_played", "round", "round_number"),
        default=None,
    )
    out = {
        "map": _first(data, "map_name", "MapName", "map"),
        "matchid": None if loaded in (None, "") else str(loaded),
        "rounds_played": rounds,
        "gamestate": gamestate,
    }
    cfg = _first(data, "loaded_config_file")
    out["config_loaded"] = bool(cfg) or bool(
        gamestate and str(gamestate).lower() not in ("none", "free", "warmup", "0")
    )
    for side in ("team1", "team2"):
        t = data.get(side)
        if isinstance(t, dict):
            out[side + "_name"] = t.get("name")
            out[side + "_score"] = _to_int(t.get("score"), default=None)
    return {k: v for k, v in out.items() if v is not None}


# ---- Round backup parsing ----------------------------------------------

BACKUP_NAME_RE = re.compile(
    r"matchzy_(?P<matchid>\d+)_(?P<mapnumber>\d+)_round(?P<round>\d+)"
    r"(?P<ext>\.txt|\.json)?$"
)

KV_RE = re.compile(r'"(?P<key>[^"]+)"\s+"(?P<value>[^"]*)"')


def parse_backup_name(filename: str):
    """'…/matchzy_12_0_round07.txt' -> {matchid, mapnumber, round, ...}."""
    base = filename.strip().rsplit("/", 1)[-1]
    m = BACKUP_NAME_RE.search(base)
    if not m:
        return None
    return {
        "filename": base,
        "matchid": m.group("matchid"),
        "mapnumber": int(m.group("mapnumber")),
        "round": int(m.group("round")),
        "round_str": m.group("round"),
        "ext": m.group("ext") or "",
    }


def parse_backup_txt(text: str):
    """Pull the interesting KeyValues out of an engine round-backup .txt."""
    flat = {}
    for m in KV_RE.finditer(text):
        flat.setdefault(m.group("key"), m.group("value"))
    out = {
        "map": flat.get("MapName") or flat.get("mapname"),
        "round": _to_int(flat.get("round"), default=None),
        "rounds_played": _to_int(flat.get("RoundsPlayed"), default=None),
        "first_half_score": None,
        "team1_score": _to_int(flat.get("Team1_Score"), default=None),
        "team2_score": _to_int(flat.get("Team2_Score"), default=None),
    }
    fhs = flat.get("FirstHalfScore")
    if fhs is not None:
        out["first_half_score"] = _to_int(fhs, default=fhs)
    if out["round"] is None:
        out["round"] = out["rounds_played"]
    return out


BACKUP_SPLIT_RE = re.compile(r"^===== (?P<path>.+?) =====$", re.MULTILINE)


def split_concatenated_backups(text: str):
    """Parse the `===== <path> =====` + file body stream we fetch over ssh."""
    out = []
    parts = BACKUP_SPLIT_RE.split(text)
    # parts = [preamble, path1, body1, path2, body2, ...]
    for i in range(1, len(parts) - 1, 2):
        path = parts[i].strip()
        body = parts[i + 1]
        meta = parse_backup_name(path) or {"filename": path.rsplit("/", 1)[-1]}
        meta = dict(meta)
        meta["path"] = path
        meta.update(
            {k: v for k, v in parse_backup_txt(body).items() if v is not None}
        )
        out.append(meta)
    out.sort(key=lambda b: (b.get("matchid") or "", b.get("mapnumber") or 0, b.get("round") or 0))
    return out


def pick_backup(backups, round_no, matchid=None, mapnumber=None):
    """Choose exactly one backup to restore.  Ambiguity is an error, not a guess."""
    cands = [b for b in backups if b.get("round") == int(round_no)]
    if matchid is not None:
        cands = [b for b in cands if str(b.get("matchid")) == str(matchid)]
    if mapnumber is not None:
        cands = [b for b in cands if b.get("mapnumber") == int(mapnumber)]
    if not cands:
        raise LookupError(
            "no round backup for round %s%s"
            % (round_no, "" if matchid is None else " of match %s" % matchid)
        )
    keys = {(b.get("matchid"), b.get("mapnumber")) for b in cands}
    if len(keys) > 1:
        raise LookupError(
            "round %s is ambiguous across %s; pass --matchid/--mapnumber"
            % (round_no, sorted(str(k) for k in keys))
        )
    return cands[-1]


def restore_command(backup):
    """FACT 2: css_restore silently no-ops.  Use the engine command."""
    name = backup["filename"]
    if name.endswith(".json"):
        name = name[: -len(".json")] + ".txt"
    if not name.endswith(".txt"):
        name += ".txt"
    return 'mp_backup_restore_load_file %s' % name


# ---- Whitelist reply (FACT 4) ------------------------------------------

def parse_whitelist_reply(text: str):
    """css_whitelist is a toggle that ignores its argument -> read the reply."""
    if not text:
        return None
    low = text.lower()
    if "enabled" in low:
        return True
    if "disabled" in low:
        return False
    return None


# ---- Match config generation -------------------------------------------

class ConfigError(ValueError):
    pass


# MatchZy parses matchid as a 32-bit signed int, so "all digits" is not
# enough: a YYMMDDHHMM stamp like 2609192112 is 2.6 billion, overflows, and
# is rejected with "matchid should be an integer!" — verified against a live
# server. Anything from 2021 onwards in that format fails.
MATCHID_MAX = 2 ** 31 - 1


def validate_matchid(matchid) -> str:
    """FACT 7: matchid must be an integer string that fits in int32."""
    s = str(matchid).strip()
    if not re.fullmatch(r"\d+", s):
        raise ConfigError(
            "matchid must be an integer string (got %r); a word makes MatchZy "
            "reject the config" % matchid
        )
    if int(s) > MATCHID_MAX:
        raise ConfigError(
            "matchid %s exceeds int32 (%d); MatchZy parses it as a 32-bit int "
            "and answers 'matchid should be an integer!'" % (s, MATCHID_MAX)
        )
    return s


def validate_roster(team_label, team_name, players):
    """Per-team checks: a team name, and every entry a real SteamID64.

    The size rule (empty / partial) is a rule about BOTH teams at once and
    lives in validate_rosters(); it cannot be decided one team at a time.
    """
    if not team_name or not str(team_name).strip():
        raise ConfigError("%s has no team name" % team_label)
    bad = [sid for sid in players or {} if not is_valid_steamid64(sid)]
    if bad:
        raise ConfigError(
            "%s (%s) has invalid SteamID64 entries: %s"
            % (team_label, team_name, ", ".join(sorted(bad)))
        )
    return {str(k): str(v) for k, v in (players or {}).items()}


def validate_rosters(team1_name, team1_players, team2_name, team2_players,
                     players_per_team=5):
    """FACT 3, in full.  Never overridable with --force.

    MatchZy kicks every connected player who is not in a roster, so:

      * BOTH rosters empty  -> allowed.  MatchZy with empty rosters kicks
        nobody; this is the preferred mode of operation.
      * exactly one roster empty -> REFUSED.  The empty team's five players are
        all "not in the roster" and get kicked one by one.
      * a roster with 1..players_per_team-1 entries -> REFUSED.  This is the
        partial roster that repeatedly kicked a legitimate player at the event.
      * both rosters with >= players_per_team entries -> allowed.
    """
    ppt = int(players_per_team)
    p1 = validate_roster("team1", team1_name, team1_players)
    p2 = validate_roster("team2", team2_name, team2_players)

    if not p1 and not p2:
        return p1, p2  # both empty: MatchZy kicks nobody.

    for label, name, players in (
        ("team1", team1_name, p1),
        ("team2", team2_name, p2),
    ):
        if not players:
            raise ConfigError(
                "%s (%s) has an EMPTY roster while the other team's roster is "
                "NOT empty. MatchZy would kick every player of %s with "
                "'KICKING PLAYER ... (NOT ALLOWED!)'. Refusing — this is not "
                "overridable with --force. Either fill this roster "
                "(lag_match.py capture, then lag_match.py roster), or leave "
                "BOTH rosters empty, which kicks nobody."
                % (label, name, name)
            )
        if len(players) < ppt:
            raise ConfigError(
                "%s (%s) has a PARTIAL roster: %d of %d players_per_team. "
                "MatchZy kicks everyone missing from the roster with "
                "'KICKING PLAYER ... (NOT ALLOWED!)', so the %d missing "
                "player(s) would be kicked off a live server. Refusing — this "
                "is not overridable with --force. Add the missing players "
                "(lag_match.py roster --add), lower --players-per-team, or "
                "leave BOTH rosters empty, which kicks nobody."
                % (label, name, len(players), ppt, ppt - len(players))
            )
    return p1, p2


def build_match_config(
    matchid,
    team1_name,
    team1_players,
    team2_name,
    team2_players,
    maplist,
    bo=1,
    skip_veto=True,
    players_per_team=5,
    clinch_series=True,
    cvars=None,
):
    """Build a MatchZy match config.

    team1 starts CT (FACT 5) — encoded in map_sides and asserted by callers.
    The economy cvars are pinned here because with no config loaded MatchZy
    re-execs warmup.cfg and stomps manual fixes (FACT 6).
    """
    mid = validate_matchid(matchid)
    p1, p2 = validate_rosters(
        team1_name, team1_players, team2_name, team2_players,
        players_per_team=players_per_team,
    )

    overlap = set(p1) & set(p2)
    if overlap:
        raise ConfigError(
            "these SteamIDs are on BOTH teams: %s" % ", ".join(sorted(overlap))
        )

    maps = [m.strip() for m in maplist if m and m.strip()]
    if not maps:
        raise ConfigError("maplist is empty")
    num_maps = int(bo)
    if num_maps not in (1, 3, 5):
        raise ConfigError("--bo must be 1, 3 or 5 (got %r)" % bo)
    if skip_veto and len(maps) < num_maps:
        raise ConfigError(
            "bo%d needs %d maps with veto skipped, got %d (%s)"
            % (num_maps, num_maps, len(maps), ", ".join(maps))
        )
    if skip_veto:
        maps = maps[:num_maps]
    elif len(maps) < num_maps:
        raise ConfigError(
            "a veto for bo%d needs at least %d maps in the pool" % (num_maps, num_maps)
        )

    cfg = {
        "matchid": mid,
        "num_maps": num_maps,
        "players_per_team": int(players_per_team),
        "min_players_to_ready": 1,
        "skip_veto": bool(skip_veto),
        "maplist": maps,
        "clinch_series": bool(clinch_series),
        "team1": {"name": str(team1_name), "players": p1},
        "team2": {"name": str(team2_name), "players": p2},
        "cvars": {
            "hostname": "LahtiAG | %s vs %s" % (team1_name, team2_name),
            "mp_startmoney": "800",
            "mp_starting_losses": "0",
        },
    }
    if skip_veto:
        # FACT 5: team1 is CT at match start.  Stale side mappings make MatchZy
        # drag players to the wrong side forever.
        cfg["map_sides"] = ["team1_ct"] * len(maps)
    if cvars:
        cfg["cvars"].update({str(k): str(v) for k, v in cvars.items()})
    return cfg


def config_side_note(cfg):
    """Human-readable statement of the documented side mapping (FACT 5)."""
    note = (
        "team1 = %s starts CT; team2 = %s starts T. If this is wrong the config "
        "will drag players to the wrong side continuously."
        % (cfg["team1"]["name"], cfg["team2"]["name"])
    )
    if not cfg["team1"]["players"] and not cfg["team2"]["players"]:
        note += (
            "\n\nBoth rosters are EMPTY, which is the normal way to run this: "
            "nobody has to hand over a SteamID, MatchZy kicks nobody, and anyone "
            "may join either side. The names above are just the scoreboard. "
            "LahtiAGTeams works out who is on which team from the sides when the "
            "match goes live, and puts people back there after a reconnect."
        )
    return note


def default_matchid(now=None):
    """An int32-safe matchid (FACT 7) derived from the clock.

    MMDDHHMM, not YYMMDDHHMM: the longer form overflows MatchZy's 32-bit
    parse.  This repeats annually, which is fine — matchid only needs to be
    unique against the backup files currently on disk.
    """
    ts = now if now is not None else time.time()
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%m%d%H%M")


# ---- Server state + safety decisions -----------------------------------

class ServerState(dict):
    """Plain dict with helpers; keys may be None meaning 'unknown'."""

    @property
    def humans(self):
        return self.get("humans")

    @property
    def rounds_played(self):
        return self.get("rounds_played")

    @property
    def config_loaded(self):
        return self.get("config_loaded")


def build_server_state(
    server, status_text, get5_text=None, log_text=None, teamname_text=None
):
    """Fold every probe we have into one state dict.  Pure."""
    st = parse_status(status_text or "")
    state = ServerState(
        {
            "server": server,
            "instance": SERVERS.get(server, {}).get("instance"),
            "map": st["map"],
            "humans": st["humans"],
            "bots": st["bots"],
            "players": st["players"],
            "rounds_played": None,
            "config_loaded": None,
            "matchid": None,
            "team1_name": None,
            "team2_name": None,
            "team1_score": None,
            "team2_score": None,
            "gamestate": None,
            "ready": {},
        }
    )
    g5 = state_from_get5_status(parse_get5_status(get5_text or ""))
    for k, v in g5.items():
        if v is not None:
            state[k] = v
    if teamname_text:
        names = parse_teamnames(teamname_text)
        for k, v in names.items():
            if v and not state.get(k):
                state[k] = v
    if log_text:
        state["ready"] = parse_team_ready_lines(log_text)
        if state.get("config_loaded") is None:
            state["config_loaded"] = log_says_config_loaded(log_text)
        if state.get("matchid") is None:
            mid = log_matchid(log_text)
            if mid:
                state["matchid"] = mid
    if state.get("config_loaded") is False:
        # No config is loaded, so any matchid we scraped is from a match that is
        # over.  Showing it invites restoring yesterday's backup onto today.
        state["matchid"] = None
    return state


TEAMNAME_RE = re.compile(
    r'"mp_teamname_(?P<n>[12])"\s*=\s*"(?P<val>[^"]*)"', re.IGNORECASE
)


def parse_teamnames(text: str):
    out = {}
    for m in TEAMNAME_RE.finditer(text or ""):
        out["team%s_name" % m.group("n")] = m.group("val")
    return out


# Only CONFIRMED OUTCOMES count as evidence.  A typed command is not evidence:
# `css_endmatch` can be rejected (no permission, no match running) and the match
# carries on, so matching the command echo would flip config_loaded to False for
# a match that never ended — the tool would then happily load over it.
CONFIG_LOADED_RE = re.compile(
    r"(\[LoadMatchFromJSON\][^\n]*\bSuccess\b|Match configuration loaded|"
    r"Loaded match config|Match setup completed)",
    re.IGNORECASE,
)
CONFIG_ENDED_RE = re.compile(
    r"(Match has been ended|Series has ended|Match ended)",
    re.IGNORECASE,
)

# `rcon from "127.0.0.1:54112": command "css_endmatch"` — the server echoing
# what somebody TYPED.  Never evidence of anything, whatever it contains.
RCON_ECHO_RE = re.compile(r'rcon from\s+"[^"]*"\s*:\s*command\s+"', re.IGNORECASE)
# The local console echo of a typed command, same story.
CONSOLE_ECHO_RE = re.compile(r'\bConsole:\s*"', re.IGNORECASE)

LOG_MATCHID_RE = re.compile(r'"?matchid"?["\s:=]+(?P<id>\d+)', re.IGNORECASE)


def is_command_echo(line: str) -> bool:
    """True for a line that only reports a command was TYPED, not its outcome."""
    return bool(RCON_ECHO_RE.search(line) or CONSOLE_ECHO_RE.search(line))


def log_says_config_loaded(log_text: str):
    """Last confirmed-outcome marker wins.  None when the log says nothing.

    Command echoes are skipped entirely: an attempted-but-rejected command must
    never be read as a match having ended (or started).
    """
    result = None
    for line in log_text.splitlines():
        if is_command_echo(line):
            continue
        if CONFIG_ENDED_RE.search(line):
            result = False
        elif CONFIG_LOADED_RE.search(line):
            result = True
    return result


def log_matchid(log_text: str):
    found = LOG_MATCHID_RE.findall(log_text or "")
    return found[-1] if found else None


def is_live(state) -> bool:
    """Spec definition: a config is loaded AND/OR rounds have been played.

    rounds_played == -1 means "no match" (MatchZy/Get5 convention); >= 0 means a
    match exists.  Unknown (None) is NOT treated as live on its own — but see
    describe_state(): unknowns are reported so the operator can see them.
    """
    if state.get("config_loaded") is True:
        return True
    rp = state.get("rounds_played")
    if rp is not None and rp >= 0:
        return True
    return False


def describe_state(state) -> str:
    def s(v):
        return "unknown" if v is None else v

    parts = [
        "server %s (%s)" % (state.get("server"), s(state.get("instance"))),
        "map=%s" % s(state.get("map")),
        "humans=%s" % s(state.get("humans")),
        "rounds_played=%s" % s(state.get("rounds_played")),
        "config_loaded=%s" % s(state.get("config_loaded")),
        "matchid=%s"
        % (
            "none (no config loaded)"
            if state.get("config_loaded") is False and not state.get("matchid")
            else s(state.get("matchid"))
        ),
        "teams=%s vs %s" % (s(state.get("team1_name")), s(state.get("team2_name"))),
        "score=%s-%s" % (s(state.get("team1_score")), s(state.get("team2_score"))),
    ]
    return ", ".join(str(p) for p in parts)


class Decision:
    def __init__(self, allowed, reasons=None, warnings=None):
        self.allowed = bool(allowed)
        self.reasons = list(reasons or [])
        self.warnings = list(warnings or [])

    def __repr__(self):  # pragma: no cover - debugging aid
        return "Decision(allowed=%r, reasons=%r)" % (self.allowed, self.reasons)


# Mutations that are MEANT to happen during a live match, so refusing them
# would only train the operator to type --force by reflex.  Each one is gated
# on something specific instead (restore: the backup's matchid must match;
# bot: it only changes the bot count, on a side the operator names).
LIVE_SAFE_ACTIONS = {"restore", "bot"}

LIVE_HINTS = {
    "load": (
        "Loading a config over an autostarted live match SILENTLY DESTROYS it "
        "(MatchZy only refuses loads over config-started matches). This is the "
        "bug that wiped two live games."
    ),
    # `restore` is deliberately NOT in this table: restoring a round backup is
    # by definition done during a live match, so refusing it here would make
    # --force the normal way to restore — and an operator trained to type
    # --force reflexively defeats every other refusal in this tool.  restore is
    # gated instead on the round existing AND the backup's matchid matching the
    # match that is actually running (check_backup_matches_state).
    "end": "Refusing to end a live match without --force.",
    "names": (
        "Renaming teams mid-match is usually harmless but is still a mutation; "
        "re-run with --force if that is what you want."
    ),
}


def check_backup_matches_state(backup, state):
    """Refusal reasons for restoring `backup` onto the match in `state`.

    A round backup from a previous match (or a previous day) restored onto a
    live match rewinds it to somebody else's scoreline.  The filename carries
    the matchid; compare it with the match that is actually running and fail
    closed when either side is unknown.
    """
    reasons = []
    backup_mid = backup.get("matchid")
    server_mid = state.get("matchid")
    if not backup_mid:
        reasons.append(
            "The backup %r carries NO matchid, so it cannot be shown to belong "
            "to the running match. Refusing — pass --force only if you are "
            "certain this file is from the match on the server right now."
            % backup.get("filename")
        )
    elif not server_mid:
        reasons.append(
            "The server's current matchid is UNKNOWN (no config loaded, or "
            "get5_status/log gave no answer), so backup %s (match %s) cannot be "
            "shown to belong to it. Refusing — check `status`, or pass --force."
            % (backup.get("filename"), backup_mid)
        )
    elif str(backup_mid) != str(server_mid):
        reasons.append(
            "STALE BACKUP: %s is from match %s but the server is running match "
            "%s. Restoring it would rewind this match to a DIFFERENT match's "
            "scoreline. Refusing — pass --matchid %s to pick this match's own "
            "backup, or --force if you really mean it."
            % (backup.get("filename"), backup_mid, server_mid, server_mid)
        )
    return reasons


def check_safety(action, state, force=False, humans_allowed=False,
                 extra_reasons=None):
    """The whole point of the tool.

    action: "load" | "end" | "restore" | "names" | other mutating name.
    Returns a Decision.  `force` can override the live-match, connected-human,
    unknown-liveness and stale-backup refusals (the operator says they know).
    It can NEVER override the empty/partial roster refusal — that lives in
    validate_rosters(), reached from build_match_config().
    """
    reasons = list(extra_reasons or [])
    warnings = []

    live = is_live(state)
    if live and action not in LIVE_SAFE_ACTIONS:
        reasons.append(
            "A MATCH LOOKS LIVE: %s. %s"
            % (
                describe_state(state),
                LIVE_HINTS.get(action, "Refusing to mutate a live match."),
            )
        )
    elif live and action == "restore":
        warnings.append(
            "A match is live: %s. That is the normal case for `restore` — it is "
            "gated on the round existing and on the backup's matchid matching "
            "this match, not on --force." % describe_state(state)
        )
    elif live and action == "bot":
        warnings.append(
            "A match is live: %s. That is the normal case for `bot` — someone "
            "has just dropped. It touches nothing but the bot count."
            % describe_state(state)
        )
    if state.get("config_loaded") is None and state.get("rounds_played") is None:
        reasons.append(
            "LIVENESS UNKNOWN: neither get5_status nor the log said whether a "
            "match is running (%s). A connected-player count of 0 is NOT proof "
            "the server is idle. Refusing to mutate a server whose state could "
            "not be determined — this is exactly the unknown that destroyed a "
            "live game. Check the server, or pass --force." % describe_state(state)
        )

    if action == "load" and not humans_allowed:
        humans = state.get("humans")
        if humans is None:
            reasons.append(
                "Player count is UNKNOWN. `load` refuses unless it can prove the "
                "server is empty — loading a config mid-session caused every "
                "incident in this tournament."
            )
        elif humans > 0:
            reasons.append(
                "%d human player(s) are connected. Loading a match config while "
                "players are on the server is what caused every incident: "
                "MatchZy kicks anyone not in the roster and can destroy a live "
                "game. Empty the server, or pass --force if you are certain."
                % humans
            )

    if state.get("config_loaded") is False and action != "load":
        warnings.append(
            "No match config is loaded: MatchZy keeps re-execing warmup.cfg, "
            "which resets mp_startmoney to 16000 and mp_starting_losses to 1. "
            "Manual economy fixes will not stick."
        )

    if not reasons:
        return Decision(True, warnings=warnings)
    if force:
        return Decision(
            True,
            warnings=warnings
            + ["!!! --force OVERRIDES these refusals. Proceeding anyway:"]
            + ["  ! " + r for r in reasons],
        )
    return Decision(False, reasons=reasons, warnings=warnings)


# ---- Registry (pure transforms) ----------------------------------------

def empty_registry():
    return {"version": 1, "players": {}, "rosters": {}}


def merge_players(registry, captured, server=None, now_iso=None):
    """Merge, never overwrite.  Keeps last-seen timestamps."""
    reg = dict(registry or empty_registry())
    reg.setdefault("players", {})
    reg.setdefault("rosters", {})
    players = dict(reg["players"])
    stamp = now_iso or datetime.now(timezone.utc).isoformat()
    added, updated = 0, 0
    for sid, rec in (captured or {}).items():
        old = dict(players.get(sid) or {})
        if old:
            updated += 1
        else:
            added += 1
        old["steamid"] = sid
        if rec.get("name"):
            old["name"] = rec["name"]
        if rec.get("side"):
            old["side"] = rec["side"]
        old["last_seen"] = rec.get("last_seen") or stamp
        if server is not None:
            old["last_server"] = str(server)
        players[sid] = old
    reg["players"] = players
    return reg, added, updated


def roster_add(registry, team, entries):
    """entries: [(steamid_any, name)] -> registry with the roster merged in."""
    reg = dict(registry or empty_registry())
    reg.setdefault("rosters", {})
    reg.setdefault("players", {})
    rosters = dict(reg["rosters"])
    team_map = dict(rosters.get(team) or {})
    for raw_sid, name in entries:
        sid = steamid64_from_steam3(str(raw_sid))
        if not is_valid_steamid64(sid):
            raise ConfigError("not a SteamID64: %r" % raw_sid)
        team_map[sid] = name or (reg["players"].get(sid, {}).get("name") or sid)
    rosters[team] = team_map
    reg["rosters"] = rosters
    return reg


def parse_roster_add_arg(arg: str):
    """'STEAMID=NAME' -> (steamid, name).  NAME may contain '='."""
    if "=" not in arg:
        raise ConfigError("--add expects STEAMID=NAME (got %r)" % arg)
    sid, name = arg.split("=", 1)
    sid, name = sid.strip(), name.strip()
    if not sid or not name:
        raise ConfigError("--add expects STEAMID=NAME (got %r)" % arg)
    return sid, name


def roster_players(registry, team):
    return dict((registry.get("rosters") or {}).get(team) or {})


# ---- Command construction (pure) ---------------------------------------

def ssh_argv(remote_cmd, host=SSH_HOST, identity_agent=SSH_IDENTITY_AGENT):
    """The single place the ssh invocation is built (swappable / mockable)."""
    return [
        "ssh",
        "-o",
        "IdentityAgent=%s" % identity_agent,
        "-o",
        "BatchMode=yes",
        host,
        remote_cmd,
    ]


def rcon_remote_cmd(server, command):
    """The host helper takes care of finding the (regenerated) rcon password."""
    if server not in SERVERS:
        raise ValueError("unknown server %r (use 1 or 2)" % server)
    return "/usr/local/bin/cs2 %s %s" % (server, shlex.quote(command))


def write_file_remote_cmd(path):
    return "cat > %s" % shlex.quote(path)


def read_newest_log_cmd(server, lines=4000):
    # AMP log filenames contain a space ("AMPLOG_2026-09-19 21-11-31.log"), so
    # the path must survive word splitting: -d '\n' makes xargs split on
    # newlines only, and -I keeps it as one argument.
    d = shlex.quote(instance_dir(server) + "/AMP_Logs")
    return (
        "ls -1t %s/*.log 2>/dev/null | head -n1 | "
        "xargs -r -d '\\n' -I{} tail -n %d {}" % (d, int(lines))
    )


def list_backups_cmd(server):
    d = shlex.quote(csgo_dir(server))
    return (
        "for f in %s/matchzy_*_round*.txt; do [ -e \"$f\" ] || continue; "
        'echo "===== $f ====="; cat "$f"; done' % d
    )


def load_plan(server, cfg, remote_path=None):
    """Exact, ordered list of steps `load` would perform.  Pure."""
    path = remote_path or (csgo_dir(server) + "/%s.json" % cfg["matchid"])
    return {
        "config_path": path,
        "steps": [
            {"kind": "write", "path": path, "desc": "upload match config"},
            {
                "kind": "rcon",
                "command": "matchzy_loadmatch %s" % path.rsplit("/", 1)[-1],
                "desc": "load the match config",
            },
            {
                "kind": "rcon",
                "command": "mp_teamname_1 %s" % quote_cvar(cfg["team1"]["name"]),
                "desc": "team1 name (CT at match start)",
            },
            {
                "kind": "rcon",
                "command": "mp_teamname_2 %s" % quote_cvar(cfg["team2"]["name"]),
                "desc": "team2 name (T at match start)",
            },
        ],
        "verify": [
            {
                "kind": "log",
                "desc": "read [IsTeamReady] playerCount for both teams",
            }
        ],
    }


def quote_cvar(value: str) -> str:
    v = str(value).replace('"', "")
    return '"%s"' % v


def end_plan(server):
    return {"steps": [{"kind": "rcon", "command": "css_endmatch", "desc": "end the match"}]}


def names_plan(server, ct_name, t_name):
    return {
        "steps": [
            {
                "kind": "rcon",
                "command": "mp_teamname_1 %s" % quote_cvar(ct_name),
                "desc": "mp_teamname_1 = starting CT",
            },
            {
                "kind": "rcon",
                "command": "mp_teamname_2 %s" % quote_cvar(t_name),
                "desc": "mp_teamname_2 = starting T",
            },
        ]
    }


def restore_plan(server, backup):
    return {
        "steps": [
            {
                "kind": "rcon",
                "command": restore_command(backup),
                "desc": "engine-level restore (css_restore is unreliable)",
            }
        ],
        "backup": backup,
    }


BOT_SIDES = {"t": "bot_add_t", "ct": "bot_add_ct"}

# A bot that plays like a warm body is the point: it is standing in for a
# disconnected human, and a bot that whiffs everything hands the round to the
# other side just as surely as playing 4v5 does.
BOT_DIFFICULTY_DEFAULT = 3
BOT_MAX_PER_CALL = 5


def normalise_side(side):
    """'T', 'ct', 'CT' -> 't'/'ct'.  Anything else is an error, not a guess."""
    s = str(side).strip().lower()
    if s not in BOT_SIDES:
        raise ValueError(
            "side must be 't' or 'ct', not %r — a bot has to be placed on a "
            "named side, because letting the engine choose is what made it "
            "6v4." % side
        )
    return s


def bot_add_plan(server, side, count=1, difficulty=BOT_DIFFICULTY_DEFAULT):
    """Put `count` bots on ONE named side.

    FACT 9.  Every step before the bot_add_* calls exists to stop the engine
    second-guessing the placement:

      * bot_quota_mode normal — in `fill` mode bot_quota is a TOTAL head count
        for the server and the engine picks the side itself.  In `normal` mode
        bot_quota is just a count of bots, and bot_add_* raises it by one and
        puts the bot where it is told.
      * mp_autoteambalance 0 — otherwise the engine may shuffle the bot back.
      * bot_join_after_player 0 — bots we add explicitly should not wait.
    """
    side = normalise_side(side)
    count = int(count)
    if count < 1 or count > BOT_MAX_PER_CALL:
        raise ValueError(
            "count must be 1..%d (got %r); a 5v5 server never needs more"
            % (BOT_MAX_PER_CALL, count)
        )
    difficulty = int(difficulty)
    if difficulty < 0 or difficulty > 3:
        raise ValueError("difficulty must be 0..3 (3 = expert), got %r" % difficulty)
    steps = [
        {
            "kind": "rcon",
            "command": "bot_quota_mode normal",
            "desc": "fill mode lets the engine pick the side (FACT 9)",
        },
        {
            "kind": "rcon",
            "command": "mp_autoteambalance 0",
            "desc": "stop the engine shuffling the bot back",
        },
        {
            "kind": "rcon",
            "command": "bot_join_after_player 0",
            "desc": "an explicitly added bot should not wait for a human",
        },
        {
            "kind": "rcon",
            "command": "bot_difficulty %d" % difficulty,
            "desc": "3 = expert; a weak stand-in loses the round anyway",
        },
    ]
    for _ in range(count):
        steps.append(
            {
                "kind": "rcon",
                "command": BOT_SIDES[side],
                "desc": "add one bot to %s (raises bot_quota by one)" % side.upper(),
            }
        )
    return {"steps": steps, "side": side, "count": count}


def bot_kick_plan(server, side=None):
    """Kick bots from one side, or all of them when side is None."""
    if side is None:
        return {
            "steps": [
                {
                    "kind": "rcon",
                    "command": "bot_kick",
                    "desc": "kick every bot (also drops bot_quota to 0)",
                }
            ],
            "side": None,
        }
    side = normalise_side(side)
    return {
        "steps": [
            {
                "kind": "rcon",
                "command": "bot_kick %s" % side,
                "desc": "kick the bots on %s only" % side.upper(),
            }
        ],
        "side": side,
    }


def format_ready_report(ready, expected1=None, expected2=None):
    """FACT: confirm both teams show the expected count BEFORE forcing a start."""
    if not ready:
        return (
            "No [IsTeamReady] lines seen yet. Wait for players to connect/ready, "
            "then re-run `status` — do NOT force a start until both teams report "
            "the expected playerCount."
        )
    lines = []
    for team in sorted(ready):
        exp = expected1 if team == 1 else expected2
        got = ready[team]
        mark = ""
        if exp is not None:
            mark = "  OK" if got == exp else "  MISMATCH (expected %d)" % exp
        lines.append("[IsTeamReady] team: %d  playerCount: %d%s" % (team, got, mark))
    return "\n".join(lines)


def snapshot_payload(state, action, now_iso=None):
    return {
        "taken_at": now_iso or datetime.now(timezone.utc).isoformat(),
        "action": action,
        "server": state.get("server"),
        "instance": state.get("instance"),
        "map": state.get("map"),
        "humans": state.get("humans"),
        "rounds_played": state.get("rounds_played"),
        "config_loaded": state.get("config_loaded"),
        "matchid": state.get("matchid"),
        "teams": {
            "team1": state.get("team1_name"),
            "team2": state.get("team2_name"),
        },
        "score": {
            "team1": state.get("team1_score"),
            "team2": state.get("team2_score"),
        },
        "players": state.get("players") or [],
        "ready": state.get("ready") or {},
    }


def snapshot_filename(server, action, now=None):
    dt = now or datetime.now(timezone.utc)
    return "%s_srv%s_%s.json" % (dt.strftime("%Y%m%dT%H%M%SZ"), server, action)


# ==========================================================================
# I/O LAYER
# ==========================================================================

class Runner:
    """All process execution goes through here so tests can swap it out."""

    def __init__(self, host=SSH_HOST, identity_agent=SSH_IDENTITY_AGENT, timeout=30):
        self.host = host
        self.identity_agent = identity_agent
        self.timeout = timeout

    def run_remote(self, remote_cmd, stdin_data=None):
        argv = ssh_argv(remote_cmd, self.host, self.identity_agent)
        proc = subprocess.run(
            argv,
            input=stdin_data.encode() if stdin_data is not None else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=self.timeout,
        )
        out = proc.stdout.decode("utf-8", "replace")
        err = proc.stderr.decode("utf-8", "replace")
        if proc.returncode != 0:
            raise RuntimeError(
                "ssh failed (%d): %s" % (proc.returncode, (err or out).strip())
            )
        return out

    def rcon(self, server, command):
        return self.run_remote(rcon_remote_cmd(server, command))

    def read_log(self, server, lines=4000):
        return self.run_remote(read_newest_log_cmd(server, lines))

    def list_backups_raw(self, server):
        return self.run_remote(list_backups_cmd(server))

    def write_file(self, path, content):
        return self.run_remote(write_file_remote_cmd(path), stdin_data=content)


def load_registry():
    try:
        with open(registry_path(), "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return empty_registry()
    if not isinstance(data, dict):
        return empty_registry()
    data.setdefault("players", {})
    data.setdefault("rosters", {})
    return data


def save_registry(reg):
    os.makedirs(home_dir(), exist_ok=True)
    tmp = registry_path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(reg, fh, indent=2, sort_keys=True)
        fh.write("\n")
    os.replace(tmp, registry_path())
    return registry_path()


def write_snapshot(state, action):
    os.makedirs(snapshots_dir(), exist_ok=True)
    path = os.path.join(
        snapshots_dir(), snapshot_filename(state.get("server"), action)
    )
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(snapshot_payload(state, action), fh, indent=2, sort_keys=True)
        fh.write("\n")
    return path


def collect_state(runner, server, with_log=True):
    status_text = runner.rcon(server, "status")
    try:
        get5_text = runner.rcon(server, "get5_status")
    except Exception:
        get5_text = ""
    teamname_text = ""
    for cvar in ("mp_teamname_1", "mp_teamname_2"):
        try:
            teamname_text += runner.rcon(server, cvar)
        except Exception:
            pass
    log_text = ""
    if with_log:
        try:
            log_text = runner.read_log(server, 2000)
        except Exception:
            log_text = ""
    return build_server_state(server, status_text, get5_text, log_text, teamname_text)


# ==========================================================================
# CLI
# ==========================================================================

def expand_servers(arg):
    if arg in (None, "all"):
        return ["1", "2"]
    if arg not in SERVERS:
        raise SystemExit("unknown server %r (use 1, 2 or all)" % arg)
    return [arg]


def print_plan(plan, cfg=None):
    print("\n--- DRY RUN: nothing has been executed ---")
    if cfg is not None:
        print("\nGenerated match config (%s):" % plan.get("config_path", "?"))
        print(json.dumps(cfg, indent=2, sort_keys=True))
        print("\n" + config_side_note(cfg))
    print("\nWould run:")
    for i, step in enumerate(plan["steps"], 1):
        if step["kind"] == "rcon":
            print("  %d. rcon: %s        # %s" % (i, step["command"], step["desc"]))
        elif step["kind"] == "write":
            print("  %d. upload -> %s    # %s" % (i, step["path"], step["desc"]))
    print("\nRe-run with --yes to execute.")


def execute_plan(runner, server, plan, cfg=None):
    results = []
    for step in plan["steps"]:
        if step["kind"] == "write":
            runner.write_file(step["path"], json.dumps(cfg, indent=2, sort_keys=True) + "\n")
            print("uploaded %s" % step["path"])
            results.append(("write", step["path"], "ok"))
        elif step["kind"] == "rcon":
            out = runner.rcon(server, step["command"])
            print("rcon> %s\n%s" % (step["command"], out.strip()))
            results.append(("rcon", step["command"], out))
    return results


# --------------------------------------------------------------------------
# The bridge: lahtiag.fi queues matches, this drains the queue
# --------------------------------------------------------------------------
#
# The site is the controller, but it runs on Cloudflare Workers and has no
# route to these servers — they sit behind a home connection, and opening
# RCON to the internet to give it one would be a far worse trade. So the
# site publishes a queue and this pulls from it, exactly like the Minecraft
# whitelist bridge.
#
# The dangerous part is the load itself: matchzy_loadmatch over an
# autostarted live match SILENTLY DESTROYS it (FACT 1), and it has wiped two
# live games. So this refuses to load onto a server with a live match, and
# claims a queued match from the site BEFORE touching the server, so the same
# match is never offered twice.

SITE_ENV = "LAG_SITE"
TOKEN_ENV = "LAG_CS2_TOKEN"


def site_request(site, path, token, payload=None, timeout=15):
    """GET, or POST when payload is given. Returns parsed JSON."""
    url = site.rstrip("/") + path
    data = None
    headers = {"X-MatchZy-Token": token, "accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode()
        headers["content-type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode() or "{}")


def bridge_should_load(state):
    """Whether it is safe to load a queued match onto this server.

    Humans being connected is FINE and is the normal case: the site's config
    carries EMPTY rosters, so MatchZy kicks nobody. A live match is not
    fine — loading over it destroys it.

    Unknown liveness is treated as live. The whole point of this refusal is
    the case where we could not tell, which is exactly the unknown that
    destroyed a live game.
    """
    if state.get("config_loaded") is None and state.get("rounds_played") is None:
        return False, "could not tell whether a match is running"
    if is_live(state):
        return False, "a match is live: %s" % describe_state(state)
    return True, ""


def bridge_setup_plan(server, site, token):
    """The three cvars that point a server at the site. Idempotent."""
    base = site.rstrip("/")
    return {
        "steps": [
            {
                "kind": "rcon",
                "command": 'matchzy_match_token "%s"' % token,
                "desc": "shared token; also sets the remote-log header key",
            },
            {
                "kind": "rcon",
                "command": 'matchzy_remote_log_url "%s/api/cs2/events"' % base,
                "desc": "where the server reports what it is doing",
            },
        ]
    }


def cmd_bridge(args, runner):
    site = args.site or os.environ.get(SITE_ENV)
    token = args.token or os.environ.get(TOKEN_ENV)
    if not site or not token:
        print(
            "error: need the site and the shared token. Pass --site/--token, or "
            "set %s and %s." % (SITE_ENV, TOKEN_ENV),
            file=sys.stderr,
        )
        return 2

    if args.setup:
        for server in expand_servers(args.server):
            plan = bridge_setup_plan(server, site, token)
            if not args.yes:
                print("server %s:" % server)
                print_plan(plan)
            else:
                execute_plan(runner, server, plan)
        if not args.yes:
            return 0

    while True:
        try:
            queue = site_request(site, "/api/cs2/queue", token).get("matches") or []
        except (urllib.error.URLError, ValueError, OSError) as exc:
            print("could not read the queue: %s" % exc, file=sys.stderr)
            queue = []

        for match in queue:
            server = str(match.get("server"))
            if server not in SERVERS:
                print("skipping match %s: unknown server %r" % (match.get("id"), server))
                continue
            state = collect_state(runner, server)
            ok, why = bridge_should_load(state)
            if not ok:
                print("server %s not ready for match %s: %s" % (server, match["id"], why))
                continue

            # Claim FIRST. If the site says somebody else already has it, we
            # must not touch the server: the load is the destructive step.
            try:
                claimed = site_request(site, "/api/cs2/queue", token, {"id": match["id"]}).get("claimed")
            except (urllib.error.URLError, ValueError, OSError) as exc:
                print("could not claim match %s: %s" % (match["id"], exc), file=sys.stderr)
                continue
            if not claimed:
                print("match %s was already claimed; leaving server %s alone" % (match["id"], server))
                continue

            print("loading match %s (%s vs %s, bo%s) onto server %s"
                  % (match["id"], match.get("team1"), match.get("team2"),
                     match.get("best_of"), server))
            print(runner.rcon(server, 'matchzy_loadmatch_url "%s"' % match["url"]).strip())

        if args.once:
            return 0
        time.sleep(max(5, args.interval))


def cmd_status(args, runner):
    for server in expand_servers(args.server):
        state = collect_state(runner, server)
        print("=" * 72)
        print(describe_state(state))
        print("live: %s" % ("YES" if is_live(state) else "no"))
        players = state.get("players") or []
        if players:
            print("players (%d):" % len(players))
            for p in players:
                print("  %-24s %s" % (p["name"][:24], p["steamid"]))
        ready = state.get("ready") or {}
        if ready:
            print(format_ready_report(ready))
        if state.get("config_loaded") is False:
            print(
                "note: no config loaded -> MatchZy re-execs warmup.cfg "
                "(mp_startmoney->16000, mp_starting_losses->1)."
            )
    return 0


def cmd_capture(args, runner):
    server = args.server
    log_text = runner.read_log(server, args.lines)
    captured = parse_players_from_log(log_text)
    reg, added, updated = merge_players(load_registry(), captured, server=server)
    path = save_registry(reg)
    print("captured %d player(s) from server %s (%d new, %d updated)"
          % (len(captured), server, added, updated))
    for sid, rec in sorted(captured.items(), key=lambda kv: kv[1].get("name", "")):
        print("  %-24s %s  %s  %s"
              % (rec.get("name", "?")[:24], sid, rec.get("side", "?"),
                 rec.get("last_seen", "")))
    print("registry: %s" % path)
    return 0


def cmd_roster(args, runner):
    reg = load_registry()
    if args.add:
        entries = [parse_roster_add_arg(a) for a in args.add]
        reg = roster_add(reg, args.team, entries)
        if not args.yes:
            print("--- DRY RUN ---")
            print("would set roster %r to:" % args.team)
            for sid, name in sorted(roster_players(reg, args.team).items()):
                print("  %s = %s" % (sid, name))
            print("\nRe-run with --yes to write the registry.")
            return 0
        save_registry(reg)
        print("roster %r saved (%d players)" % (args.team, len(roster_players(reg, args.team))))
    players = roster_players(reg, args.team)
    if not players:
        print("roster %r is EMPTY. `load` accepts empty rosters only when BOTH "
              "teams are empty (MatchZy then kicks nobody); mixed with a "
              "non-empty roster, or partially filled, it will refuse."
              % args.team)
        return 1
    print("roster %r (%d):" % (args.team, len(players)))
    for sid, name in sorted(players.items(), key=lambda kv: kv[1].lower()):
        print("  %s = %s" % (sid, name))
    return 0


def cmd_load(args, runner):
    server = args.server
    reg = load_registry()
    t1 = roster_players(reg, args.team1)
    t2 = roster_players(reg, args.team2)

    matchid = validate_matchid(args.matchid or default_matchid())

    if args.map:
        maps = [args.map]
    elif args.maps:
        maps = [m.strip() for m in args.maps.split(",") if m.strip()]
    elif args.veto:
        maps = list(DEFAULT_MAPPOOL)
    else:
        raise SystemExit("pass --map MAP, or --maps M1,M2,... , or --veto")

    cfg = build_match_config(
        matchid,
        args.team1,
        t1,
        args.team2,
        t2,
        maps,
        bo=args.bo,
        skip_veto=not args.veto,
        players_per_team=args.players_per_team,
    )

    state = collect_state(runner, server)
    snap = write_snapshot(state, "load")
    print("snapshot: %s" % snap)
    print(describe_state(state))

    decision = check_safety("load", state, force=args.force)
    for w in decision.warnings:
        print("WARNING: %s" % w)
    if not decision.allowed:
        print("\nREFUSING to load:")
        for r in decision.reasons:
            print("  - %s" % r)
        return 2

    plan = load_plan(server, cfg)
    if not args.yes:
        print_plan(plan, cfg)
        return 0

    execute_plan(runner, server, plan, cfg)
    print("\n" + config_side_note(cfg))
    print("\nWaiting for MatchZy readiness lines...")
    try:
        log_text = runner.read_log(server, 400)
    except Exception as exc:
        print("could not read log: %s" % exc)
        return 0
    print(format_ready_report(parse_team_ready_lines(log_text),
                              len(cfg["team1"]["players"]) or None,
                              len(cfg["team2"]["players"]) or None))
    kicks = parse_kick_lines(log_text)
    if kicks:
        print("\n!! MatchZy kicked: %s\n   -> a roster is wrong/incomplete."
              % ", ".join(kicks))
    return 0


def _mutate(args, runner, action, plan_builder, extra_check=None):
    server = args.server
    state = collect_state(runner, server)
    snap = write_snapshot(state, action)
    print("snapshot: %s" % snap)
    print(describe_state(state))
    extra = list(extra_check(state)) if extra_check else []
    decision = check_safety(action, state, force=args.force, extra_reasons=extra)
    for w in decision.warnings:
        print("WARNING: %s" % w)
    if not decision.allowed:
        print("\nREFUSING to %s:" % action)
        for r in decision.reasons:
            print("  - %s" % r)
        return 2
    plan = plan_builder(state)
    if not args.yes:
        print_plan(plan)
        return 0
    execute_plan(runner, server, plan)
    return 0


def cmd_end(args, runner):
    return _mutate(args, runner, "end", lambda state: end_plan(args.server))


def cmd_names(args, runner):
    return _mutate(
        args, runner, "names", lambda state: names_plan(args.server, args.ct, args.t)
    )


def cmd_bot(args, runner):
    """Stand a bot in for a player who dropped — on the side that lost them.

    This is deliberately an explicit, operator-named side rather than anything
    automatic.  `status` cannot see which team a player is on, so a tool that
    guessed would be guessing exactly the thing that went wrong (FACT 9).
    """
    if args.action == "add" and args.side is None:
        print(
            "error: `bot add` needs a side: `bot %s add t` or `bot %s add ct`. "
            "It is not inferred — the engine inferring it is what made a 5v4 "
            "into a 6v4." % (args.server, args.server),
            file=sys.stderr,
        )
        return 2
    if args.action == "kick":
        plan_builder = lambda state: bot_kick_plan(args.server, args.side)
    else:
        plan_builder = lambda state: bot_add_plan(
            args.server, args.side, args.count, args.difficulty
        )
        print(
            "NOTE: this sets bot_quota_mode to `normal` for the running map. A "
            "map change re-execs lahtiag_server.cfg, so if that file still says "
            "`bot_quota_mode fill` the engine goes back to choosing sides on "
            "its own — fix the cfg, not just the live server."
        )
    return _mutate(args, runner, "bot", plan_builder)


def cmd_restore(args, runner):
    backups = split_concatenated_backups(runner.list_backups_raw(args.server))
    try:
        backup = pick_backup(backups, args.round, args.matchid, args.mapnumber)
    except LookupError as exc:
        print("cannot restore: %s" % exc)
        if backups:
            print("available rounds: %s"
                  % ", ".join(str(b.get("round")) for b in backups))
        return 2
    print("selected backup: %s (map=%s score=%s)"
          % (backup.get("filename"), backup.get("map"),
             backup.get("first_half_score")))
    return _mutate(
        args,
        runner,
        "restore",
        lambda state: restore_plan(args.server, backup),
        extra_check=lambda state: check_backup_matches_state(backup, state),
    )


def cmd_backups(args, runner):
    backups = split_concatenated_backups(runner.list_backups_raw(args.server))
    if not backups:
        print("no round backups found in %s" % csgo_dir(args.server))
        return 0
    print("%-40s %-6s %-12s %-10s %s" % ("file", "round", "map", "matchid", "score"))
    for b in backups:
        print("%-40s %-6s %-12s %-10s %s"
              % (b.get("filename"), b.get("round"), b.get("map") or "?",
                 b.get("matchid") or "?", b.get("first_half_score")))
    print("\nRestore with: lag_match.py restore %s <round> --yes" % args.server)
    return 0


def build_parser():
    p = argparse.ArgumentParser(
        prog="lag_match.py",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        description="Safe administration of the LahtiAG CS2 (MatchZy) servers.",
        epilog=(
            "Safety model\n"
            "------------\n"
            "  * Mutating commands read server state first and REFUSE if a match\n"
            "    looks live (config loaded and/or rounds played). --force overrides.\n"
            "  * They also REFUSE when liveness could not be determined at all:\n"
            "    0 connected players is not proof the server is idle.\n"
            "  * `load` also refuses while any human is connected (--force overrides).\n"
            "  * `load` ALWAYS refuses an EMPTY roster when the other team's roster is\n"
            "    not empty, and ALWAYS refuses a PARTIAL roster (fewer entries than\n"
            "    --players-per-team): MatchZy kicks everyone missing from a roster.\n"
            "    There is no override for those. Two EMPTY rosters are fine and are\n"
            "    the normal mode: MatchZy with empty rosters kicks nobody.\n"
            "  * `restore` is NOT blocked by the live-match rule (restoring happens\n"
            "    during a live match); it is gated on the round existing and on the\n"
            "    backup's matchid matching the running match.\n"
            "  * Every mutating command writes a JSON snapshot to %s first.\n"
            "  * Everything is a DRY RUN until you pass --yes.\n"
            "  * status / backups never mutate anything and need no --yes.\n"
            "  * `roster` is read-only WITHOUT --add; with --add it edits the LOCAL\n"
            "    registry (and needs --yes). It never touches a server either way.\n"
            "\nGotchas this tool works around\n"
            "------------------------------\n"
            "  * matchzy_loadmatch silently destroys an AUTOSTARTED live match.\n"
            "  * css_restore often no-ops -> we use mp_backup_restore_load_file.\n"
            "  * css_whitelist is a toggle that ignores its argument.\n"
            "  * team1 is CT at match start; a stale mapping drags players sideways.\n"
            "  * No config loaded -> warmup.cfg re-exec resets the economy cvars.\n"
            "  * matchid must be an integer string.\n"
            "  * ~2 min tvFlushDelay between maps. It is not stuck.\n"
            % snapshots_dir()
        ),
    )
    p.add_argument("--host", default=SSH_HOST, help="ssh target (default: %(default)s)")
    p.add_argument(
        "--identity-agent",
        default=SSH_IDENTITY_AGENT,
        help="ssh IdentityAgent socket (default: %(default)s)",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("status", help="READ-ONLY server state")
    sp.add_argument("server", nargs="?", default="all", choices=["1", "2", "all"])
    sp.set_defaults(func=cmd_status)

    sp = sub.add_parser("capture", help="record connected players into the registry")
    sp.add_argument("server", choices=["1", "2"])
    sp.add_argument("--lines", type=int, default=4000, help="log lines to scan")
    sp.set_defaults(func=cmd_capture)

    sp = sub.add_parser("roster", help="show or edit a named team roster")
    sp.add_argument("team")
    sp.add_argument(
        "--add", action="append", metavar="STEAMID=NAME",
        help="add/replace a player (repeatable); STEAMID may be [U:1:x] or 64-bit",
    )
    sp.add_argument("--yes", action="store_true", help="actually write the registry")
    sp.set_defaults(func=cmd_roster)

    sp = sub.add_parser("load", help="generate and load a MatchZy match config")
    sp.add_argument("server", choices=["1", "2"])
    sp.add_argument(
        "--team1", required=True,
        help="team name on the scoreboard; starts CT. No SteamIDs needed: if a "
             "saved roster of this name exists its players are pinned, and "
             "otherwise the roster is left empty, which is the normal case.",
    )
    sp.add_argument(
        "--team2", required=True,
        help="team name on the scoreboard; starts T. Same rules as --team1.",
    )
    sp.add_argument("--map", help="single map (bo1)")
    sp.add_argument("--maps", help="comma-separated maplist")
    sp.add_argument("--veto", action="store_true", help="let MatchZy run the veto")
    sp.add_argument("--bo", type=int, default=1, choices=[1, 3, 5])
    sp.add_argument("--matchid", help="integer string; default: derived from the clock")
    sp.add_argument("--players-per-team", type=int, default=5)
    sp.add_argument("--force", action="store_true", help="override live/humans refusals")
    sp.add_argument("--yes", action="store_true", help="actually execute")
    sp.set_defaults(func=cmd_load)

    sp = sub.add_parser("end", help="css_endmatch")
    sp.add_argument("server", choices=["1", "2"])
    sp.add_argument("--force", action="store_true")
    sp.add_argument("--yes", action="store_true")
    sp.set_defaults(func=cmd_end)

    sp = sub.add_parser("restore", help="engine-level restore of a round backup")
    sp.add_argument("server", choices=["1", "2"])
    sp.add_argument("round", type=int)
    sp.add_argument("--matchid")
    sp.add_argument("--mapnumber", type=int)
    sp.add_argument("--force", action="store_true")
    sp.add_argument("--yes", action="store_true")
    sp.set_defaults(func=cmd_restore)

    sp = sub.add_parser("names", help="set mp_teamname_1 / mp_teamname_2")
    sp.add_argument("server", choices=["1", "2"])
    sp.add_argument("--ct", required=True, help="name for mp_teamname_1 (starting CT)")
    sp.add_argument("--t", required=True, help="name for mp_teamname_2 (starting T)")
    sp.add_argument("--force", action="store_true")
    sp.add_argument("--yes", action="store_true")
    sp.set_defaults(func=cmd_names)

    sp = sub.add_parser(
        "bot",
        help="add/kick bots on a NAMED side (stand-in for a disconnect)",
    )
    sp.add_argument("server", choices=["1", "2"])
    sp.add_argument("action", choices=["add", "kick"])
    sp.add_argument(
        "side", nargs="?", choices=["t", "ct", "T", "CT"],
        help="which side. Required for `add`; omit on `kick` to kick all bots.",
    )
    sp.add_argument("--count", type=int, default=1, help="bots to add (default 1)")
    sp.add_argument(
        "--difficulty", type=int, default=BOT_DIFFICULTY_DEFAULT,
        choices=[0, 1, 2, 3], help="0=easy .. 3=expert (default %(default)s)",
    )
    sp.add_argument("--force", action="store_true")
    sp.add_argument("--yes", action="store_true")
    sp.set_defaults(func=cmd_bot)

    sp = sub.add_parser(
        "bridge",
        help="drain lahtiag.fi's match queue onto the servers (the site cannot reach them)",
    )
    sp.add_argument("server", nargs="?", default="all", choices=["1", "2", "all"],
                    help="only used by --setup; the queue names its own server")
    sp.add_argument("--site", help="e.g. https://lahtiag.fi (or $%s)" % SITE_ENV)
    sp.add_argument("--token", help="the shared token (or $%s)" % TOKEN_ENV)
    sp.add_argument("--setup", action="store_true",
                    help="point the server(s) at the site first (idempotent)")
    sp.add_argument("--once", action="store_true", help="one pass, then exit")
    sp.add_argument("--interval", type=int, default=10, help="seconds between polls")
    sp.add_argument("--yes", action="store_true", help="actually execute --setup")
    sp.set_defaults(func=cmd_bridge)

    sp = sub.add_parser("backups", help="READ-ONLY list of round backups")
    sp.add_argument("server", choices=["1", "2"])
    sp.set_defaults(func=cmd_backups)

    return p


def _argv_text(cmd):
    if isinstance(cmd, (list, tuple)):
        return " ".join(str(c) for c in cmd)
    return str(cmd)


def main(argv=None):
    args = build_parser().parse_args(argv)
    runner = Runner(host=args.host, identity_agent=args.identity_agent)
    try:
        return args.func(args, runner)
    except (ConfigError, ValueError) as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 2
    except subprocess.TimeoutExpired as exc:
        print(
            "error: the ssh/rcon call timed out after %ss (%s). Nothing was "
            "confirmed: the command may or may not have reached the server — "
            "check `lag_match.py status %s` before retrying."
            % (exc.timeout, _argv_text(exc.cmd), getattr(args, "server", "1")),
            file=sys.stderr,
        )
        return 1
    except RuntimeError as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
