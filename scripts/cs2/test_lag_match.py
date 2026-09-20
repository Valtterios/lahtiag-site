#!/usr/bin/env python3
"""Unit tests for lag_match.py.

Pure logic only: no network, no server, no ssh.  Run with:

    cd scripts/cs2 && python3 -m unittest discover
"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import lag_match as lm  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures — trimmed from real AMP logs / backup files
# ---------------------------------------------------------------------------

AMP_LOG = """\
[2026-09-14 17:58:02] [Console:Info] Server is hibernating
[2026-09-14 17:58:03] [Console:Info] Console: "cs2.sh +ip 0.0.0.0 -port 27015 +rcon_password deadbeefdeadbeef +map de_mirage"
[2026-09-14 18:01:11] [Console:Info] "Nikke<2><[U:1:123456789]><>" connected, address ""
[2026-09-14 18:01:12] [Console:Info] "Nikke<2><[U:1:123456789]><Unassigned>" joined team "CT"
[2026-09-14 18:01:44] [Console:Info] "Tomppa<3><[U:1:87654321]><Unassigned>" joined team "TERRORIST"
[2026-09-14 18:02:01] [Console:Info] "Nikke<2><[U:1:123456789]><CT>" say "ready"
[2026-09-14 18:02:05] [Console:Info] [MatchZy] [IsTeamReady] team: 1, isReady: True, playerCount: 5
[2026-09-14 18:02:06] [Console:Info] [MatchZy] [IsTeamReady] team: 2, isReady: False, playerCount: 4
[2026-09-14 18:03:00] [Console:Info] "Tomppa<3><[U:1:87654321]><TERRORIST>" killed "Nikke<2><[U:1:123456789]><CT>" with "ak47"
[2026-09-14 18:04:00] [Console:Info] Console: "matchzy_loadmatch 9141800.json"
[2026-09-14 18:04:01] [Console:Info] [MatchZy] Match configuration loaded: matchid 9141800
[2026-09-14 18:04:09] [Console:Info] [MatchZy] KICKING PLAYER Spectator Guy (NOT ALLOWED!)
[2026-09-14 18:04:09] [Console:Info] [MatchZy] KICKING PLAYER randomdude (NOT ALLOWED!)
[2026-09-14 18:05:00] [Console:Info] [MatchZy] [IsTeamReady] team: 2, isReady: True, playerCount: 5
"""

AMP_LOG_SECOND_PASSWORD = AMP_LOG + (
    '[2026-09-14 19:00:00] [Console:Info] Console: "cs2.sh +rcon_password aaaa1111bbbb2222"\n'
)

AMP_LOG_ENDED = AMP_LOG + (
    '[2026-09-14 19:30:00] [Console:Info] Console: "css_endmatch"\n'
    '[2026-09-14 19:30:01] [Console:Info] [MatchZy] Match has been ended by admin\n'
)

STATUS_EMPTY = """\
hostname: LahtiAG #1
version : 1.40.9.1/14009 9999 secure
map     : de_mirage
players : 0 humans, 0 bots (12/0 max) (not hibernating)

# userid name uniqueid connected ping loss state rate
"""

STATUS_TWO_HUMANS = """\
hostname: LahtiAG #1
version : 1.40.9.1/14009 9999 secure
map     : de_nuke
players : 2 humans, 0 bots (12/0 max) (not hibernating)

# userid name uniqueid connected ping loss state rate
#  2 : "Nikke"       : [U:1:123456789] 00:12 34 0 active 786432
#  3 : "Tomppa"      : [U:1:87654321]  00:11 41 0 active 786432
"""

GET5_STATUS_LIVE = """\
{
  "plugin_version": "0.8.9",
  "gamestate": "live",
  "loaded_config_file": "9141800.json",
  "matchid": "9141800",
  "map_name": "de_nuke",
  "RoundsPlayed": 12,
  "team1": {"name": "Alpha", "score": 7},
  "team2": {"name": "Bravo", "score": 5}
}
"""

GET5_STATUS_IDLE = """\
{
  "plugin_version": "0.8.9",
  "gamestate": "none",
  "loaded_config_file": "",
  "map_name": "de_mirage",
  "RoundsPlayed": -1
}
"""

GET5_UNKNOWN_COMMAND = "Unknown command 'get5_status'\n"

TEAMNAME_REPLY = (
    '"mp_teamname_1" = "Alpha" ( def. "" )\n'
    '"mp_teamname_2" = "Bravo" ( def. "" )\n'
)

BACKUP_TXT_ROUND_07 = """\
"backup"
{
	"MapName"		"de_nuke"
	"RoundsPlayed"		"7"
	"round"		"7"
	"FirstHalfScore"		"4:3"
	"Team1_Score"		"4"
	"Team2_Score"		"3"
	"ClientsIncludingSpectators"
	{
		"0"
		{
			"name"		"Nikke"
			"xuid"		"76561198083722517"
		}
	}
}
"""

BACKUP_TXT_ROUND_12 = BACKUP_TXT_ROUND_07.replace('"7"', '"12"').replace(
    '"4:3"', '"7:5"'
)

BACKUP_STREAM = (
    "===== /mnt/storage/amp-instances/LahtiAG01/counter-strike2/730/game/csgo/"
    "matchzy_9141800_0_round07.txt =====\n"
    + BACKUP_TXT_ROUND_07
    + "===== /mnt/storage/amp-instances/LahtiAG01/counter-strike2/730/game/csgo/"
    "matchzy_9141800_0_round12.txt =====\n"
    + BACKUP_TXT_ROUND_12
)

MATCHZY_JSON_BACKUP = json.dumps(
    {"matchid": "9141800", "mapnumber": "0", "round": 7}
)

# An attempted-but-REJECTED css_endmatch: the server echoes the typed command
# but the match never ended.  This must not be read as "no match is loaded".
AMP_LOG_REJECTED_ENDMATCH = AMP_LOG + (
    '[2026-09-14 19:30:00] [Console:Info] rcon from "127.0.0.1:54112": '
    'command "css_endmatch"\n'
    '[2026-09-14 19:30:00] [Console:Info] Console: "css_endmatch"\n'
)

# The real confirmed-outcome line MatchZy prints on a successful load.
AMP_LOG_LOAD_SUCCESS = (
    '[2026-09-14 20:00:00] [Console:Info] rcon from "127.0.0.1:54112": '
    'command "matchzy_loadmatch 9001.json"\n'
    '[2026-09-14 20:00:01] [Console:Info] [MatchZy] [LoadMatchFromJSON] '
    'Success with matchid: 9001!\n'
)

# Nothing at all about match state: no get5, no markers in the log.
AMP_LOG_NO_EVIDENCE = (
    "[2026-09-14 17:58:02] [Console:Info] Server is hibernating\n"
    "[2026-09-14 17:58:40] [Console:Info] Server is awake\n"
)

# Real names from this event: UTF-8, a trademark sign, a dot, and a colon.
STATUS_AWKWARD_NAMES = """\
hostname: LahtiAG #1
version : 1.40.9.1/14009 9999 secure
map     : de_mirage
players : 3 humans, 0 bots (12/0 max) (not hibernating)

# userid name uniqueid connected ping loss state rate
#  2 : "DJ J\u00f6rssi\u2122: LIVE"  : [U:1:123456789] 00:12 34 0 active 786432
#  3 : "zhang et. al"        : [U:1:87654321]  00:11 41 0 active 786432
#  4 : "L\u00fch Cr\u00e4nk"           : [U:1:11111111]  00:10 22 0 active 786432
"""

GET5_STATUS_OTHER_MATCH = GET5_STATUS_LIVE.replace("9141800", "2509010900")

BACKUP_STREAM_OTHER_MATCH = BACKUP_STREAM.replace("9141800", "2401011200")

WHITELIST_ENABLED = "[MatchZy] Whitelist Enabled!"
WHITELIST_DISABLED = "[MatchZy] Whitelist Disabled!"

# Full five-player rosters: a PARTIAL roster (1..players_per_team-1) is refused,
# so these fixtures have to be the real thing.
ROSTER_A = {
    "76561198083722517": "Nikke",
    "76561198000000001": "Tomppa",
    "76561198000000010": "DJ J\u00f6rssi\u2122",
    "76561198000000011": "zhang et. al",
    "76561198000000012": "L\u00fch Cr\u00e4nk",
}
ROSTER_B = {
    "76561198000000002": "Jaska",
    "76561198000000003": "Pete",
    "76561198000000013": "Mette",
    "76561198000000014": "Sakke",
    "76561198000000015": "Janne",
}
PARTIAL_ROSTER = {"76561198000000004": "Only", "76561198000000005": "Two"}


# ---------------------------------------------------------------------------


class TestSteamID(unittest.TestCase):
    def test_accountid_conversion(self):
        self.assertEqual(lm.steamid64_from_accountid(123456789), "76561198083722517")
        self.assertEqual(lm.steamid64_from_accountid("0"), "76561197960265728")

    def test_steam3_forms(self):
        self.assertEqual(lm.steamid64_from_steam3("[U:1:123456789]"), "76561198083722517")
        self.assertEqual(lm.steamid64_from_steam3("123456789"), "76561198083722517")
        self.assertEqual(
            lm.steamid64_from_steam3("76561198083722517"), "76561198083722517"
        )

    def test_bad_input(self):
        with self.assertRaises(ValueError):
            lm.steamid64_from_steam3("STEAM_1:1:x")
        with self.assertRaises(ValueError):
            lm.steamid64_from_accountid(-5)

    def test_validation(self):
        self.assertTrue(lm.is_valid_steamid64("76561198083722517"))
        self.assertFalse(lm.is_valid_steamid64("123"))
        self.assertFalse(lm.is_valid_steamid64("8656119808372251"))


class TestLogParsing(unittest.TestCase):
    def test_players_captured_with_sides_and_timestamps(self):
        players = lm.parse_players_from_log(AMP_LOG)
        self.assertEqual(set(players), {"76561198083722517", "76561198047920049"})
        nikke = players["76561198083722517"]
        self.assertEqual(nikke["name"], "Nikke")
        self.assertEqual(nikke["side"], "CT")  # last seen side wins
        self.assertTrue(nikke["last_seen"].startswith("2026-09-14T18:03:00"))
        self.assertEqual(players["76561198047920049"]["side"], "T")

    def test_timestamps_are_utc(self):
        dt = lm.parse_log_timestamp("[2026-09-14 18:01:11] foo")
        self.assertEqual(dt.utcoffset().total_seconds(), 0)
        self.assertIsNone(lm.parse_log_timestamp("no timestamp here"))

    def test_ready_lines_latest_wins(self):
        ready = lm.parse_team_ready_lines(AMP_LOG)
        self.assertEqual(ready, {1: 5, 2: 5})

    def test_kick_lines(self):
        self.assertEqual(
            lm.parse_kick_lines(AMP_LOG), ["Spectator Guy", "randomdude"]
        )

    def test_rcon_password_newest_wins(self):
        self.assertEqual(lm.parse_rcon_password(AMP_LOG), "deadbeefdeadbeef")
        self.assertEqual(
            lm.parse_rcon_password(AMP_LOG_SECOND_PASSWORD), "aaaa1111bbbb2222"
        )
        self.assertIsNone(lm.parse_rcon_password("nothing"))

    def test_config_loaded_marker(self):
        self.assertTrue(lm.log_says_config_loaded(AMP_LOG))
        self.assertFalse(lm.log_says_config_loaded(AMP_LOG_ENDED))
        self.assertIsNone(lm.log_says_config_loaded("[Console] hello"))

    def test_log_matchid(self):
        self.assertEqual(lm.log_matchid(AMP_LOG), "9141800")


class TestStatusParsing(unittest.TestCase):
    def test_empty_server(self):
        st = lm.parse_status(STATUS_EMPTY)
        self.assertEqual(st["map"], "de_mirage")
        self.assertEqual(st["humans"], 0)
        self.assertEqual(st["players"], [])

    def test_two_humans(self):
        st = lm.parse_status(STATUS_TWO_HUMANS)
        self.assertEqual(st["map"], "de_nuke")
        self.assertEqual(st["humans"], 2)
        self.assertEqual(
            [p["steamid"] for p in st["players"]],
            ["76561198083722517", "76561198047920049"],
        )
        self.assertEqual(st["players"][0]["name"], "Nikke")

    def test_garbage_is_unknown_not_zero(self):
        st = lm.parse_status("rcon timed out")
        self.assertIsNone(st["humans"])
        self.assertIsNone(st["map"])


class TestGet5Status(unittest.TestCase):
    def test_live(self):
        data = lm.parse_get5_status(GET5_STATUS_LIVE)
        state = lm.state_from_get5_status(data)
        self.assertTrue(state["config_loaded"])
        self.assertEqual(state["rounds_played"], 12)
        self.assertEqual(state["team1_name"], "Alpha")
        self.assertEqual(state["team2_score"], 5)
        # matchid must be the integer id, never the config filename (FACT 7)
        self.assertEqual(state["matchid"], "9141800")

    def test_idle(self):
        state = lm.state_from_get5_status(lm.parse_get5_status(GET5_STATUS_IDLE))
        self.assertFalse(state["config_loaded"])
        self.assertEqual(state["rounds_played"], -1)

    def test_unknown_command_degrades_to_none(self):
        self.assertIsNone(lm.parse_get5_status(GET5_UNKNOWN_COMMAND))
        self.assertIsNone(lm.parse_get5_status(""))
        self.assertEqual(lm.state_from_get5_status(None), {})

    def test_teamnames(self):
        self.assertEqual(
            lm.parse_teamnames(TEAMNAME_REPLY),
            {"team1_name": "Alpha", "team2_name": "Bravo"},
        )


class TestBackups(unittest.TestCase):
    def test_parse_name(self):
        meta = lm.parse_backup_name(
            "/csgo/matchzy_9141800_0_round07.txt"
        )
        self.assertEqual(meta["matchid"], "9141800")
        self.assertEqual(meta["mapnumber"], 0)
        self.assertEqual(meta["round"], 7)
        self.assertIsNone(lm.parse_backup_name("something_else.txt"))

    def test_parse_txt(self):
        b = lm.parse_backup_txt(BACKUP_TXT_ROUND_07)
        self.assertEqual(b["map"], "de_nuke")
        self.assertEqual(b["round"], 7)
        self.assertEqual(b["rounds_played"], 7)
        self.assertEqual(b["first_half_score"], "4:3")

    def test_split_stream(self):
        backups = lm.split_concatenated_backups(BACKUP_STREAM)
        self.assertEqual([b["round"] for b in backups], [7, 12])
        self.assertEqual(backups[1]["first_half_score"], "7:5")
        self.assertEqual(backups[0]["matchid"], "9141800")

    def test_json_backup_mapnumber_is_a_string(self):
        # documented gotcha: mapnumber is a string inside the .json
        data = json.loads(MATCHZY_JSON_BACKUP)
        self.assertIsInstance(data["mapnumber"], str)
        self.assertEqual(lm._to_int(data["mapnumber"]), 0)

    def test_pick_backup(self):
        backups = lm.split_concatenated_backups(BACKUP_STREAM)
        self.assertEqual(lm.pick_backup(backups, 12)["round"], 12)
        with self.assertRaises(LookupError):
            lm.pick_backup(backups, 99)

    def test_pick_backup_ambiguous(self):
        backups = lm.split_concatenated_backups(BACKUP_STREAM)
        other = dict(backups[0])
        other["matchid"] = "2609999999"
        with self.assertRaises(LookupError):
            lm.pick_backup(backups + [other], 7)
        self.assertEqual(
            lm.pick_backup(backups + [other], 7, matchid="2609999999")["matchid"],
            "2609999999",
        )

    def test_restore_uses_engine_command_not_css_restore(self):
        backups = lm.split_concatenated_backups(BACKUP_STREAM)
        cmd = lm.restore_command(backups[0])
        self.assertEqual(
            cmd, "mp_backup_restore_load_file matchzy_9141800_0_round07.txt"
        )
        self.assertNotIn("css_restore", cmd)

    def test_restore_command_rewrites_json_to_txt(self):
        cmd = lm.restore_command({"filename": "matchzy_1_0_round03.json"})
        self.assertTrue(cmd.endswith("matchzy_1_0_round03.txt"))


class TestWhitelistReply(unittest.TestCase):
    def test_reads_reply_text(self):
        self.assertIs(lm.parse_whitelist_reply(WHITELIST_ENABLED), True)
        self.assertIs(lm.parse_whitelist_reply(WHITELIST_DISABLED), False)
        self.assertIsNone(lm.parse_whitelist_reply("???"))


class TestConfigGeneration(unittest.TestCase):
    def test_happy_path(self):
        cfg = lm.build_match_config(
            "9141800", "Alpha", ROSTER_A, "Bravo", ROSTER_B, ["de_nuke"]
        )
        self.assertEqual(cfg["matchid"], "9141800")
        self.assertEqual(cfg["maplist"], ["de_nuke"])
        self.assertEqual(cfg["map_sides"], ["team1_ct"])
        self.assertEqual(cfg["team1"]["players"], ROSTER_A)
        self.assertTrue(cfg["skip_veto"])
        json.dumps(cfg)  # must be serialisable

    def test_team1_documented_as_ct(self):
        cfg = lm.build_match_config(
            "1", "Alpha", ROSTER_A, "Bravo", ROSTER_B, ["de_nuke"]
        )
        note = lm.config_side_note(cfg)
        self.assertIn("Alpha starts CT", note)
        self.assertIn("Bravo starts T", note)

    def test_matchid_must_be_integer_string(self):
        with self.assertRaises(lm.ConfigError):
            lm.validate_matchid("finals")
        with self.assertRaises(lm.ConfigError):
            lm.build_match_config(
                "grandfinal", "Alpha", ROSTER_A, "Bravo", ROSTER_B, ["de_nuke"]
            )
        self.assertEqual(lm.validate_matchid(" 42 "), "42")
        self.assertTrue(lm.default_matchid(0).isdigit())

    def test_empty_roster_is_always_refused(self):
        with self.assertRaises(lm.ConfigError) as ctx:
            lm.build_match_config("1", "Alpha", {}, "Bravo", ROSTER_B, ["de_nuke"])
        self.assertIn("EMPTY roster", str(ctx.exception))
        self.assertIn("KICKING PLAYER", str(ctx.exception))
        with self.assertRaises(lm.ConfigError):
            lm.build_match_config("1", "Alpha", ROSTER_A, "Bravo", {}, ["de_nuke"])

    def test_invalid_steamids_refused(self):
        with self.assertRaises(lm.ConfigError):
            lm.build_match_config(
                "1", "Alpha", {"12345": "x"}, "Bravo", ROSTER_B, ["de_nuke"]
            )

    def test_player_on_both_teams_refused(self):
        dupe = dict(ROSTER_B)
        dupe["76561198083722517"] = "Nikke"
        with self.assertRaises(lm.ConfigError):
            lm.build_match_config("1", "Alpha", ROSTER_A, "Bravo", dupe, ["de_nuke"])

    def test_bo3_needs_three_maps(self):
        with self.assertRaises(lm.ConfigError):
            lm.build_match_config(
                "1", "Alpha", ROSTER_A, "Bravo", ROSTER_B, ["de_nuke"], bo=3
            )
        cfg = lm.build_match_config(
            "1", "Alpha", ROSTER_A, "Bravo", ROSTER_B,
            ["de_nuke", "de_mirage", "de_inferno", "de_anubis"], bo=3,
        )
        self.assertEqual(len(cfg["maplist"]), 3)
        self.assertEqual(cfg["map_sides"], ["team1_ct"] * 3)

    def test_veto_config_has_no_side_mapping(self):
        cfg = lm.build_match_config(
            "1", "Alpha", ROSTER_A, "Bravo", ROSTER_B,
            lm.DEFAULT_MAPPOOL, bo=1, skip_veto=False,
        )
        self.assertNotIn("map_sides", cfg)
        self.assertFalse(cfg["skip_veto"])

    def test_economy_cvars_pinned(self):
        cfg = lm.build_match_config(
            "1", "Alpha", ROSTER_A, "Bravo", ROSTER_B, ["de_nuke"]
        )
        self.assertEqual(cfg["cvars"]["mp_startmoney"], "800")
        self.assertEqual(cfg["cvars"]["mp_starting_losses"], "0")

    def test_empty_maplist(self):
        with self.assertRaises(lm.ConfigError):
            lm.build_match_config("1", "A", ROSTER_A, "B", ROSTER_B, [" ", ""])


class TestServerState(unittest.TestCase):
    def test_live_from_get5(self):
        state = lm.build_server_state("1", STATUS_TWO_HUMANS, GET5_STATUS_LIVE)
        self.assertTrue(lm.is_live(state))
        self.assertEqual(state["humans"], 2)
        self.assertEqual(state["rounds_played"], 12)

    def test_idle_is_not_live(self):
        state = lm.build_server_state("1", STATUS_EMPTY, GET5_STATUS_IDLE)
        self.assertFalse(lm.is_live(state))

    def test_rounds_played_minus_one_is_not_live(self):
        self.assertFalse(lm.is_live({"rounds_played": -1, "config_loaded": False}))
        self.assertTrue(lm.is_live({"rounds_played": 0, "config_loaded": False}))

    def test_log_fallback_when_get5_unknown(self):
        state = lm.build_server_state(
            "1", STATUS_TWO_HUMANS, GET5_UNKNOWN_COMMAND, AMP_LOG, TEAMNAME_REPLY
        )
        self.assertTrue(state["config_loaded"])  # from the log marker
        self.assertTrue(lm.is_live(state))
        self.assertEqual(state["ready"], {1: 5, 2: 5})
        self.assertEqual(state["team1_name"], "Alpha")
        self.assertEqual(state["matchid"], "9141800")

    def test_ended_log_is_not_live(self):
        state = lm.build_server_state(
            "1", STATUS_EMPTY, GET5_UNKNOWN_COMMAND, AMP_LOG_ENDED
        )
        self.assertFalse(state["config_loaded"])
        self.assertFalse(lm.is_live(state))

    def test_describe_state_mentions_unknowns(self):
        text = lm.describe_state(lm.build_server_state("1", "garbage"))
        self.assertIn("unknown", text)


class TestSafety(unittest.TestCase):
    def idle_empty(self):
        return lm.build_server_state("1", STATUS_EMPTY, GET5_STATUS_IDLE)

    def live_state(self):
        return lm.build_server_state("1", STATUS_TWO_HUMANS, GET5_STATUS_LIVE)

    def test_load_allowed_on_idle_empty_server(self):
        d = lm.check_safety("load", self.idle_empty())
        self.assertTrue(d.allowed)

    def test_load_refused_when_live(self):
        d = lm.check_safety("load", self.live_state())
        self.assertFalse(d.allowed)
        joined = " ".join(d.reasons)
        self.assertIn("LIVE", joined)
        self.assertIn("SILENTLY DESTROYS", joined)
        self.assertIn("de_nuke", joined)  # explains what it saw

    def test_load_refused_when_humans_connected(self):
        state = lm.build_server_state("1", STATUS_TWO_HUMANS, GET5_STATUS_IDLE)
        d = lm.check_safety("load", state)
        self.assertFalse(d.allowed)
        self.assertTrue(any("2 human" in r for r in d.reasons))

    def test_load_refused_when_player_count_unknown(self):
        state = lm.build_server_state("1", "rcon timeout", GET5_STATUS_IDLE)
        d = lm.check_safety("load", state)
        self.assertFalse(d.allowed)
        self.assertTrue(any("UNKNOWN" in r for r in d.reasons))

    def test_force_overrides_live_and_humans(self):
        d = lm.check_safety("load", self.live_state(), force=True)
        self.assertTrue(d.allowed)
        self.assertTrue(any("OVERRIDES" in w for w in d.warnings))

    def test_end_refused_when_live(self):
        self.assertFalse(lm.check_safety("end", self.live_state()).allowed)
        self.assertTrue(lm.check_safety("end", self.idle_empty()).allowed)

    def test_end_ignores_connected_humans(self):
        state = lm.build_server_state("1", STATUS_TWO_HUMANS, GET5_STATUS_IDLE)
        self.assertTrue(lm.check_safety("end", state).allowed)

    def test_restore_is_not_blocked_by_the_live_refusal(self):
        # A restore always happens during a live match; blocking it here would
        # train the operator to pass --force every time.
        d = lm.check_safety("restore", self.live_state())
        self.assertTrue(d.allowed)
        self.assertTrue(any("normal case for `restore`" in w for w in d.warnings))
        # ...but the other mutating actions are still refused on the same state.
        self.assertFalse(lm.check_safety("end", self.live_state()).allowed)

    def test_extra_reasons_refuse_and_are_forceable(self):
        d = lm.check_safety("restore", self.live_state(),
                            extra_reasons=["STALE BACKUP: nope"])
        self.assertFalse(d.allowed)
        self.assertIn("STALE BACKUP: nope", d.reasons)
        d = lm.check_safety("restore", self.live_state(), force=True,
                            extra_reasons=["STALE BACKUP: nope"])
        self.assertTrue(d.allowed)

    def test_totally_unknown_liveness_is_refused_not_warned(self):
        # Finding 2: humans can legitimately read 0, so "no evidence either way"
        # must fail closed for every mutating action.
        state = lm.build_server_state("1", STATUS_EMPTY, GET5_UNKNOWN_COMMAND)
        self.assertIsNone(state.get("config_loaded"))
        self.assertIsNone(state.get("rounds_played"))
        for action in ("end", "names", "load", "restore"):
            d = lm.check_safety(action, state, humans_allowed=True)
            self.assertFalse(d.allowed, action)
            self.assertTrue(any("LIVENESS UNKNOWN" in r for r in d.reasons), action)

    def test_unknown_liveness_overridable_by_force_loudly(self):
        state = lm.build_server_state("1", STATUS_EMPTY, GET5_UNKNOWN_COMMAND)
        d = lm.check_safety("end", state, force=True)
        self.assertTrue(d.allowed)
        self.assertTrue(any("OVERRIDES" in w for w in d.warnings))
        self.assertTrue(any("LIVENESS UNKNOWN" in w for w in d.warnings))

    def test_no_config_loaded_warns_about_warmup_economy(self):
        d = lm.check_safety("end", self.idle_empty())
        self.assertTrue(any("warmup.cfg" in w for w in d.warnings))

    def test_humans_allowed_bypass_for_non_load_actions(self):
        state = lm.build_server_state("1", STATUS_TWO_HUMANS, GET5_STATUS_IDLE)
        d = lm.check_safety("load", state, humans_allowed=True)
        self.assertTrue(d.allowed)


class TestCommandConstruction(unittest.TestCase):
    def test_ssh_argv_is_built_in_one_place(self):
        argv = lm.ssh_argv("echo hi")
        self.assertEqual(argv[0], "ssh")
        self.assertIn("IdentityAgent=/tmp/aura-agent.sock", argv)
        self.assertEqual(argv[-2], lm.SSH_HOST)
        self.assertEqual(argv[-1], "echo hi")

    def test_rcon_quoting(self):
        cmd = lm.rcon_remote_cmd("2", 'mp_teamname_1 "Team; rm -rf /"')
        self.assertTrue(cmd.startswith("/usr/local/bin/cs2 2 "))
        self.assertNotIn("; rm -rf /'", cmd.replace("'\"'\"'", ""))
        self.assertIn("mp_teamname_1", cmd)

    def test_rcon_rejects_unknown_server(self):
        with self.assertRaises(ValueError):
            lm.rcon_remote_cmd("3", "status")

    def test_paths(self):
        self.assertEqual(
            lm.csgo_dir("2"),
            "/mnt/storage/amp-instances/LahtiAG201/counter-strike2/730/game/csgo",
        )
        self.assertIn("LahtiAG01/AMP_Logs", lm.read_newest_log_cmd("1"))
        self.assertIn("ls -1t", lm.read_newest_log_cmd("1"))  # newest by mtime

    def test_load_plan_order(self):
        cfg = lm.build_match_config(
            "42", "Alpha", ROSTER_A, "Bravo", ROSTER_B, ["de_nuke"]
        )
        plan = lm.load_plan("1", cfg)
        kinds = [s["kind"] for s in plan["steps"]]
        self.assertEqual(kinds[0], "write")  # config uploaded before loading
        self.assertIn("matchzy_loadmatch 42.json", plan["steps"][1]["command"])
        self.assertIn('mp_teamname_1 "Alpha"', plan["steps"][2]["command"])
        self.assertIn('mp_teamname_2 "Bravo"', plan["steps"][3]["command"])
        self.assertTrue(plan["config_path"].endswith("/csgo/42.json"))

    def test_names_plan_maps_ct_to_teamname_1(self):
        plan = lm.names_plan("1", "Alpha", "Bravo")
        self.assertIn('mp_teamname_1 "Alpha"', plan["steps"][0]["command"])
        self.assertIn('mp_teamname_2 "Bravo"', plan["steps"][1]["command"])

    def test_end_plan(self):
        self.assertEqual(lm.end_plan("1")["steps"][0]["command"], "css_endmatch")

    def test_quote_cvar_strips_quotes(self):
        self.assertEqual(lm.quote_cvar('Te"am'), '"Team"')


class TestReadyReport(unittest.TestCase):
    def test_matches_expected(self):
        text = lm.format_ready_report({1: 5, 2: 5}, 5, 5)
        self.assertIn("team: 1", text)
        self.assertIn("OK", text)
        self.assertNotIn("MISMATCH", text)

    def test_mismatch_flagged(self):
        text = lm.format_ready_report({1: 5, 2: 4}, 5, 5)
        self.assertIn("MISMATCH (expected 5)", text)

    def test_no_lines(self):
        self.assertIn("do NOT force a start", lm.format_ready_report({}))


class TestRegistry(unittest.TestCase):
    def test_merge_does_not_overwrite_other_players(self):
        reg = lm.empty_registry()
        reg["players"]["76561198000000009"] = {
            "steamid": "76561198000000009",
            "name": "Old",
            "last_seen": "2026-01-01T00:00:00+00:00",
        }
        captured = lm.parse_players_from_log(AMP_LOG)
        reg2, added, updated = lm.merge_players(reg, captured, server="1")
        self.assertEqual(added, 2)
        self.assertEqual(updated, 0)
        self.assertIn("76561198000000009", reg2["players"])
        self.assertEqual(reg2["players"]["76561198083722517"]["name"], "Nikke")
        self.assertEqual(reg2["players"]["76561198083722517"]["last_server"], "1")
        self.assertTrue(reg2["players"]["76561198083722517"]["last_seen"])

    def test_merge_updates_name_and_keeps_last_seen(self):
        reg, _, _ = lm.merge_players(
            lm.empty_registry(), lm.parse_players_from_log(AMP_LOG)
        )
        reg2, added, updated = lm.merge_players(
            reg,
            {"76561198083722517": {"name": "Nikke2", "side": "T",
                                   "last_seen": "2026-09-14T19:00:00+00:00"}},
        )
        self.assertEqual((added, updated), (0, 1))
        rec = reg2["players"]["76561198083722517"]
        self.assertEqual(rec["name"], "Nikke2")
        self.assertEqual(rec["last_seen"], "2026-09-14T19:00:00+00:00")

    def test_roster_add_accepts_steam3(self):
        reg = lm.roster_add(lm.empty_registry(), "Alpha",
                            [("[U:1:123456789]", "Nikke")])
        self.assertEqual(
            lm.roster_players(reg, "Alpha"), {"76561198083722517": "Nikke"}
        )

    def test_roster_add_parsing(self):
        self.assertEqual(
            lm.parse_roster_add_arg("76561198083722517=Nik=ke"),
            ("76561198083722517", "Nik=ke"),
        )
        with self.assertRaises(lm.ConfigError):
            lm.parse_roster_add_arg("76561198083722517")
        with self.assertRaises(lm.ConfigError):
            lm.parse_roster_add_arg("=Nikke")

    def test_registry_round_trip_on_disk(self):
        with tempfile.TemporaryDirectory() as d:
            old = os.environ.get(lm.HOME_ENV)
            os.environ[lm.HOME_ENV] = d
            try:
                reg = lm.roster_add(
                    lm.load_registry(), "Alpha", [("76561198083722517", "Nikke")]
                )
                lm.save_registry(reg)
                again = lm.load_registry()
                self.assertEqual(
                    lm.roster_players(again, "Alpha"),
                    {"76561198083722517": "Nikke"},
                )
            finally:
                if old is None:
                    del os.environ[lm.HOME_ENV]
                else:
                    os.environ[lm.HOME_ENV] = old

    def test_load_registry_tolerates_garbage(self):
        with tempfile.TemporaryDirectory() as d:
            old = os.environ.get(lm.HOME_ENV)
            os.environ[lm.HOME_ENV] = d
            try:
                with open(os.path.join(d, "registry.json"), "w") as fh:
                    fh.write("{not json")
                self.assertEqual(lm.load_registry(), lm.empty_registry())
            finally:
                if old is None:
                    del os.environ[lm.HOME_ENV]
                else:
                    os.environ[lm.HOME_ENV] = old


class TestSnapshots(unittest.TestCase):
    def test_payload_shape(self):
        state = lm.build_server_state(
            "1", STATUS_TWO_HUMANS, GET5_STATUS_LIVE, AMP_LOG
        )
        payload = lm.snapshot_payload(state, "load")
        for key in ("taken_at", "action", "server", "map", "humans",
                    "rounds_played", "config_loaded", "teams", "score",
                    "players"):
            self.assertIn(key, payload)
        self.assertEqual(payload["action"], "load")
        self.assertEqual(payload["teams"]["team1"], "Alpha")
        self.assertEqual(len(payload["players"]), 2)
        json.dumps(payload)

    def test_filename(self):
        name = lm.snapshot_filename("2", "end")
        self.assertTrue(name.endswith("_srv2_end.json"))

    def test_snapshot_written_to_disk(self):
        with tempfile.TemporaryDirectory() as d:
            old = os.environ.get(lm.HOME_ENV)
            os.environ[lm.HOME_ENV] = d
            try:
                state = lm.build_server_state("1", STATUS_EMPTY, GET5_STATUS_IDLE)
                path = lm.write_snapshot(state, "load")
                self.assertTrue(os.path.exists(path))
                with open(path) as fh:
                    self.assertEqual(json.load(fh)["action"], "load")
            finally:
                if old is None:
                    del os.environ[lm.HOME_ENV]
                else:
                    os.environ[lm.HOME_ENV] = old


class FakeRunner:
    """Stand-in for Runner: records everything, touches nothing."""

    def __init__(self, status=STATUS_EMPTY, get5=GET5_STATUS_IDLE,
                 log=AMP_LOG, backups=BACKUP_STREAM, teamnames=TEAMNAME_REPLY):
        self.status, self.get5, self.log = status, get5, log
        self.backups, self.teamnames = backups, teamnames
        self.rcon_calls = []
        self.writes = []

    def rcon(self, server, command):
        self.rcon_calls.append((server, command))
        if command == "status":
            return self.status
        if command == "get5_status":
            return self.get5
        if command.startswith("mp_teamname"):
            return self.teamnames
        return "ok"

    def read_log(self, server, lines=4000):
        return self.log

    def list_backups_raw(self, server):
        return self.backups

    def write_file(self, path, content):
        self.writes.append((path, content))
        return ""


class TestCliBehaviour(unittest.TestCase):
    """End-to-end through the CLI with a fake runner — still no I/O to a server."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._old = os.environ.get(lm.HOME_ENV)
        os.environ[lm.HOME_ENV] = self._tmp.name
        self.addCleanup(self._restore)
        reg = lm.roster_add(lm.empty_registry(), "Alpha",
                            [(s, n) for s, n in ROSTER_A.items()])
        reg = lm.roster_add(reg, "Bravo", [(s, n) for s, n in ROSTER_B.items()])
        lm.save_registry(reg)

    def _restore(self):
        if self._old is None:
            os.environ.pop(lm.HOME_ENV, None)
        else:
            os.environ[lm.HOME_ENV] = self._old
        self._tmp.cleanup()

    def run_cli(self, argv, runner):
        args = lm.build_parser().parse_args(argv)
        return args.func(args, runner)

    def test_status_is_read_only(self):
        r = FakeRunner()
        self.assertEqual(self.run_cli(["status", "1"], r), 0)
        self.assertTrue(all(c[1] in ("status", "get5_status", "mp_teamname_1",
                                     "mp_teamname_2") for c in r.rcon_calls))
        self.assertEqual(r.writes, [])

    def test_backups_is_read_only(self):
        r = FakeRunner()
        self.assertEqual(self.run_cli(["backups", "1"], r), 0)
        self.assertEqual(r.rcon_calls, [])
        self.assertEqual(r.writes, [])

    def test_load_dry_run_executes_nothing(self):
        r = FakeRunner()
        rc = self.run_cli(
            ["load", "1", "--team1", "Alpha", "--team2", "Bravo",
             "--map", "de_nuke"], r)
        self.assertEqual(rc, 0)
        self.assertEqual(r.writes, [])
        self.assertNotIn(
            True, [c[1].startswith("matchzy_loadmatch") for c in r.rcon_calls]
        )

    def test_load_with_yes_uploads_and_loads(self):
        r = FakeRunner()
        rc = self.run_cli(
            ["load", "1", "--team1", "Alpha", "--team2", "Bravo",
             "--map", "de_nuke", "--matchid", "42", "--yes"], r)
        self.assertEqual(rc, 0)
        self.assertEqual(len(r.writes), 1)
        cfg = json.loads(r.writes[0][1])
        self.assertEqual(cfg["matchid"], "42")
        self.assertEqual(cfg["team1"]["players"], ROSTER_A)
        self.assertTrue(
            any(c[1] == "matchzy_loadmatch 42.json" for c in r.rcon_calls)
        )

    def test_load_refuses_live_server_without_force(self):
        r = FakeRunner(status=STATUS_TWO_HUMANS, get5=GET5_STATUS_LIVE)
        rc = self.run_cli(
            ["load", "1", "--team1", "Alpha", "--team2", "Bravo",
             "--map", "de_nuke", "--yes"], r)
        self.assertEqual(rc, 2)
        self.assertEqual(r.writes, [])

    def test_load_refuses_when_humans_connected(self):
        r = FakeRunner(status=STATUS_TWO_HUMANS, get5=GET5_STATUS_IDLE)
        rc = self.run_cli(
            ["load", "1", "--team1", "Alpha", "--team2", "Bravo",
             "--map", "de_nuke", "--yes"], r)
        self.assertEqual(rc, 2)
        self.assertEqual(r.writes, [])

    def test_load_refuses_empty_roster_even_with_force(self):
        r = FakeRunner()
        with self.assertRaises(lm.ConfigError):
            self.run_cli(
                ["load", "1", "--team1", "Alpha", "--team2", "Nonexistent",
                 "--map", "de_nuke", "--yes", "--force"], r)
        self.assertEqual(r.writes, [])

    def test_load_writes_snapshot(self):
        r = FakeRunner()
        self.run_cli(
            ["load", "1", "--team1", "Alpha", "--team2", "Bravo",
             "--map", "de_nuke"], r)
        files = os.listdir(lm.snapshots_dir())
        self.assertEqual(len(files), 1)
        self.assertTrue(files[0].endswith("_srv1_load.json"))

    def test_end_dry_run_then_yes(self):
        r = FakeRunner()
        self.assertEqual(self.run_cli(["end", "1"], r), 0)
        self.assertNotIn(("1", "css_endmatch"), r.rcon_calls)
        self.assertEqual(self.run_cli(["end", "1", "--yes"], r), 0)
        self.assertIn(("1", "css_endmatch"), r.rcon_calls)

    def test_end_refused_while_live(self):
        r = FakeRunner(status=STATUS_TWO_HUMANS, get5=GET5_STATUS_LIVE)
        self.assertEqual(self.run_cli(["end", "1", "--yes"], r), 2)
        self.assertNotIn(("1", "css_endmatch"), r.rcon_calls)
        self.assertEqual(self.run_cli(["end", "1", "--yes", "--force"], r), 0)
        self.assertIn(("1", "css_endmatch"), r.rcon_calls)

    def test_restore_uses_engine_command(self):
        r = FakeRunner(status=STATUS_TWO_HUMANS, get5=GET5_STATUS_LIVE)
        rc = self.run_cli(["restore", "1", "7", "--yes", "--force"], r)
        self.assertEqual(rc, 0)
        self.assertIn(
            ("1", "mp_backup_restore_load_file matchzy_9141800_0_round07.txt"),
            r.rcon_calls,
        )

    def test_restore_unknown_round_fails_cleanly(self):
        r = FakeRunner()
        self.assertEqual(self.run_cli(["restore", "1", "99", "--yes"], r), 2)

    def test_names_dry_run(self):
        r = FakeRunner()
        self.assertEqual(
            self.run_cli(["names", "1", "--ct", "Alpha", "--t", "Bravo"], r), 0)
        self.assertFalse(any("mp_teamname_1 \"Alpha\"" == c[1] for c in r.rcon_calls))

    def test_load_refuses_partial_roster_even_with_force(self):
        # Finding 1: a roster smaller than players_per_team kicks the players it
        # forgot.  No --force path.
        reg = lm.load_registry()
        reg = lm.roster_add(reg, "Partial", list(PARTIAL_ROSTER.items()))
        lm.save_registry(reg)
        r = FakeRunner()
        with self.assertRaises(lm.ConfigError) as ctx:
            self.run_cli(
                ["load", "1", "--team1", "Alpha", "--team2", "Partial",
                 "--map", "de_nuke", "--yes", "--force"], r)
        self.assertIn("PARTIAL roster", str(ctx.exception))
        self.assertEqual(r.writes, [])

    def test_load_accepts_two_fully_empty_rosters(self):
        # Both rosters empty is the preferred mode: MatchZy kicks nobody.
        r = FakeRunner()
        rc = self.run_cli(
            ["load", "1", "--team1", "NoRosterA", "--team2", "NoRosterB",
             "--map", "de_nuke", "--matchid", "42", "--yes"], r)
        self.assertEqual(rc, 0)
        cfg = json.loads(r.writes[0][1])
        self.assertEqual(cfg["team1"]["players"], {})
        self.assertEqual(cfg["team2"]["players"], {})

    def test_load_refuses_when_liveness_is_unknown(self):
        r = FakeRunner(get5=GET5_UNKNOWN_COMMAND, log=AMP_LOG_NO_EVIDENCE)
        rc = self.run_cli(
            ["load", "1", "--team1", "Alpha", "--team2", "Bravo",
             "--map", "de_nuke", "--yes"], r)
        self.assertEqual(rc, 2)
        self.assertEqual(r.writes, [])
        r2 = FakeRunner(get5=GET5_UNKNOWN_COMMAND, log=AMP_LOG_NO_EVIDENCE)
        rc = self.run_cli(
            ["load", "1", "--team1", "Alpha", "--team2", "Bravo",
             "--map", "de_nuke", "--yes", "--force"], r2)
        self.assertEqual(rc, 0)
        self.assertEqual(len(r2.writes), 1)

    def test_restore_needs_no_force_during_a_live_match(self):
        r = FakeRunner(status=STATUS_TWO_HUMANS, get5=GET5_STATUS_LIVE)
        rc = self.run_cli(["restore", "1", "7", "--yes"], r)
        self.assertEqual(rc, 0)
        self.assertIn(
            ("1", "mp_backup_restore_load_file matchzy_9141800_0_round07.txt"),
            r.rcon_calls,
        )

    def test_restore_refuses_a_backup_from_another_match(self):
        # Finding 4: yesterday's backup file, today's live match.
        r = FakeRunner(status=STATUS_TWO_HUMANS, get5=GET5_STATUS_OTHER_MATCH)
        rc = self.run_cli(["restore", "1", "7", "--yes"], r)
        self.assertEqual(rc, 2)
        self.assertFalse(
            any(c[1].startswith("mp_backup_restore") for c in r.rcon_calls)
        )
        r2 = FakeRunner(status=STATUS_TWO_HUMANS, get5=GET5_STATUS_OTHER_MATCH)
        self.assertEqual(
            self.run_cli(["restore", "1", "7", "--yes", "--force"], r2), 0)
        self.assertTrue(
            any(c[1].startswith("mp_backup_restore") for c in r2.rcon_calls)
        )

    def test_restore_refuses_when_the_server_matchid_is_unknown(self):
        r = FakeRunner()  # idle server: no matchid to compare against
        rc = self.run_cli(["restore", "1", "7", "--yes"], r)
        self.assertEqual(rc, 2)
        self.assertFalse(
            any(c[1].startswith("mp_backup_restore") for c in r.rcon_calls)
        )

    def test_restore_still_writes_a_snapshot_first(self):
        r = FakeRunner(status=STATUS_TWO_HUMANS, get5=GET5_STATUS_LIVE)
        self.run_cli(["restore", "1", "7", "--yes"], r)
        files = os.listdir(lm.snapshots_dir())
        self.assertEqual(len(files), 1)
        self.assertTrue(files[0].endswith("_srv1_restore.json"))

    def test_capture_merges_into_registry(self):
        r = FakeRunner()
        self.assertEqual(self.run_cli(["capture", "1"], r), 0)
        reg = lm.load_registry()
        self.assertIn("76561198083722517", reg["players"])
        self.assertEqual(lm.roster_players(reg, "Alpha"), ROSTER_A)  # untouched

    def test_roster_requires_yes_to_write(self):
        r = FakeRunner()
        self.run_cli(["roster", "Charlie", "--add", "76561198000000007=Uusi"], r)
        self.assertEqual(lm.roster_players(lm.load_registry(), "Charlie"), {})
        self.run_cli(
            ["roster", "Charlie", "--add", "76561198000000007=Uusi", "--yes"], r)
        self.assertEqual(
            lm.roster_players(lm.load_registry(), "Charlie"),
            {"76561198000000007": "Uusi"},
        )


class TestPartialRosters(unittest.TestCase):
    """Finding 1: the partial-roster incident that kicked a legitimate player."""

    def test_partial_roster_is_always_refused(self):
        with self.assertRaises(lm.ConfigError) as ctx:
            lm.build_match_config(
                "1", "Alpha", ROSTER_A, "Bravo", PARTIAL_ROSTER, ["de_nuke"]
            )
        msg = str(ctx.exception)
        self.assertIn("PARTIAL roster", msg)
        self.assertIn("2 of 5", msg)
        self.assertIn("KICKING PLAYER", msg)
        self.assertIn("not overridable", msg)

    def test_partial_roster_refused_for_team1_too(self):
        with self.assertRaises(lm.ConfigError):
            lm.build_match_config(
                "1", "Alpha", PARTIAL_ROSTER, "Bravo", ROSTER_B, ["de_nuke"]
            )

    def test_one_short_of_players_per_team_is_refused(self):
        four = dict(list(ROSTER_A.items())[:4])
        with self.assertRaises(lm.ConfigError):
            lm.build_match_config(
                "1", "Alpha", four, "Bravo", ROSTER_B, ["de_nuke"]
            )

    def test_partial_roster_is_fine_at_a_lower_players_per_team(self):
        cfg = lm.build_match_config(
            "1", "Alpha", PARTIAL_ROSTER, "Bravo",
            dict(list(ROSTER_B.items())[:2]), ["de_nuke"],
            players_per_team=2,
        )
        self.assertEqual(len(cfg["team1"]["players"]), 2)

    def test_both_rosters_empty_is_allowed(self):
        cfg = lm.build_match_config("1", "Alpha", {}, "Bravo", {}, ["de_nuke"])
        self.assertEqual(cfg["team1"]["players"], {})
        self.assertEqual(cfg["team2"]["players"], {})
        json.dumps(cfg)

    def test_one_empty_one_full_is_refused_both_ways(self):
        for t1, t2 in ((ROSTER_A, {}), ({}, ROSTER_B)):
            with self.assertRaises(lm.ConfigError) as ctx:
                lm.build_match_config("1", "Alpha", t1, "Bravo", t2, ["de_nuke"])
            self.assertIn("EMPTY roster", str(ctx.exception))
            self.assertIn("BOTH rosters empty", str(ctx.exception))

    def test_validate_rosters_still_checks_names_and_ids(self):
        with self.assertRaises(lm.ConfigError):
            lm.validate_rosters("", {}, "Bravo", {})
        with self.assertRaises(lm.ConfigError):
            lm.validate_rosters("Alpha", {"123": "x"}, "Bravo", ROSTER_B)


class TestSteamIDRange(unittest.TestCase):
    """Finding (minor): no hardcoded 7656119 prefix."""

    def test_future_ids_beyond_the_7656119_prefix_are_valid(self):
        top = str(lm.STEAM_BASE + (2 ** 32 - 1))
        self.assertEqual(top[:7], "7656120")  # would fail the old prefix check
        self.assertTrue(lm.is_valid_steamid64(top))
        self.assertTrue(lm.is_valid_steamid64(str(lm.STEAM_BASE + 2500000000)))

    def test_out_of_range_and_junk_refused(self):
        self.assertFalse(lm.is_valid_steamid64(str(lm.STEAM_BASE - 1)))
        self.assertFalse(lm.is_valid_steamid64(str(lm.STEAM_BASE + 2 ** 32)))
        self.assertFalse(lm.is_valid_steamid64("12345"))
        self.assertFalse(lm.is_valid_steamid64("76561198000000abc"))
        self.assertFalse(lm.is_valid_steamid64(""))


class TestConfirmedOutcomeMarkers(unittest.TestCase):
    """Finding 3: a typed command is not evidence of an outcome."""

    def test_rejected_endmatch_echo_does_not_clear_config_loaded(self):
        self.assertTrue(lm.log_says_config_loaded(AMP_LOG_REJECTED_ENDMATCH))

    def test_rcon_echo_alone_is_never_evidence(self):
        echo = (
            '[2026-09-14 19:30:00] [Console:Info] rcon from "127.0.0.1:54112": '
            'command "css_endmatch"\n'
            '[2026-09-14 19:30:01] [Console:Info] rcon from "127.0.0.1:54112": '
            'command "matchzy_loadmatch 42.json"\n'
        )
        self.assertIsNone(lm.log_says_config_loaded(echo))
        self.assertTrue(lm.is_command_echo(echo.splitlines()[0]))

    def test_confirmed_load_success_line_counts(self):
        self.assertTrue(lm.log_says_config_loaded(AMP_LOG_LOAD_SUCCESS))

    def test_confirmed_end_line_still_counts(self):
        self.assertFalse(lm.log_says_config_loaded(AMP_LOG_ENDED))

    def test_rejected_endmatch_keeps_the_server_state_live(self):
        state = lm.build_server_state(
            "1", STATUS_TWO_HUMANS, GET5_UNKNOWN_COMMAND,
            AMP_LOG_REJECTED_ENDMATCH,
        )
        self.assertTrue(state["config_loaded"])
        self.assertTrue(lm.is_live(state))
        self.assertFalse(lm.check_safety("load", state).allowed)


class TestBackupBelongsToMatch(unittest.TestCase):
    """Finding 4: a stale backup must not be restored onto today's match."""

    def backup(self, matchid="9141800"):
        return {"filename": "matchzy_%s_0_round07.txt" % matchid,
                "matchid": matchid, "round": 7, "mapnumber": 0}

    def test_matching_matchid_is_accepted(self):
        state = lm.build_server_state("1", STATUS_TWO_HUMANS, GET5_STATUS_LIVE)
        self.assertEqual(lm.check_backup_matches_state(self.backup(), state), [])

    def test_mismatched_matchid_is_refused(self):
        state = lm.build_server_state("1", STATUS_TWO_HUMANS, GET5_STATUS_LIVE)
        reasons = lm.check_backup_matches_state(self.backup("2401011200"), state)
        self.assertTrue(any("STALE BACKUP" in r for r in reasons))
        self.assertTrue(any("9141800" in r for r in reasons))

    def test_unknown_server_matchid_is_refused(self):
        state = lm.build_server_state("1", STATUS_EMPTY, GET5_STATUS_IDLE)
        reasons = lm.check_backup_matches_state(self.backup(), state)
        self.assertTrue(any("UNKNOWN" in r for r in reasons))

    def test_backup_without_a_matchid_is_refused(self):
        state = lm.build_server_state("1", STATUS_TWO_HUMANS, GET5_STATUS_LIVE)
        reasons = lm.check_backup_matches_state(
            {"filename": "weird_backup.txt"}, state)
        self.assertTrue(any("NO matchid" in r for r in reasons))


class TestStaleMatchidHidden(unittest.TestCase):
    """Finding (minor): don't show a matchid from a match that is over."""

    def test_ended_match_clears_the_matchid(self):
        state = lm.build_server_state(
            "1", STATUS_EMPTY, GET5_UNKNOWN_COMMAND, AMP_LOG_ENDED)
        self.assertFalse(state["config_loaded"])
        self.assertIsNone(state["matchid"])
        self.assertIn("matchid=none (no config loaded)", lm.describe_state(state))

    def test_live_match_still_shows_its_matchid(self):
        state = lm.build_server_state("1", STATUS_TWO_HUMANS, GET5_STATUS_LIVE)
        self.assertIn("matchid=9141800", lm.describe_state(state))


class TestAwkwardPlayerNames(unittest.TestCase):
    """Finding (minor): real names contain colons and non-ASCII."""

    def test_colons_and_utf8_in_names(self):
        st = lm.parse_status(STATUS_AWKWARD_NAMES)
        names = [p["name"] for p in st["players"]]
        self.assertEqual(
            names, ["DJ J\u00f6rssi\u2122: LIVE", "zhang et. al", "L\u00fch Cr\u00e4nk"])
        self.assertEqual(st["humans"], 3)
        self.assertEqual(st["players"][0]["steamid"], "76561198083722517")

    def test_unquoted_name_with_a_colon_still_parses(self):
        text = (
            "players : 1 humans, 0 bots\n"
            "#  7 : DJ J\u00f6rssi\u2122: LIVE : [U:1:87654321] 00:11 41 0 active\n"
        )
        st = lm.parse_status(text)
        self.assertEqual(
            [p["name"] for p in st["players"]], ["DJ J\u00f6rssi\u2122: LIVE"])

    def test_plain_rows_still_parse(self):
        st = lm.parse_status(STATUS_TWO_HUMANS)
        self.assertEqual([p["name"] for p in st["players"]], ["Nikke", "Tomppa"])


class TestEpilogHonesty(unittest.TestCase):
    """Finding (minor): the help text claimed `roster` never mutates."""

    def test_epilog_does_not_claim_roster_is_read_only(self):
        epilog = lm.build_parser().epilog
        self.assertNotIn("roster (read-only) never mutate", epilog)
        self.assertIn("--add", epilog)
        self.assertIn("registry", epilog)

    def test_epilog_documents_the_new_rules(self):
        epilog = lm.build_parser().epilog
        self.assertIn("PARTIAL roster", epilog)
        self.assertIn("`restore` is NOT blocked", epilog)


class TestMainErrorHandling(unittest.TestCase):
    """Finding (minor): a timeout must be an error message, not a traceback."""

    def test_timeout_is_reported_cleanly(self):
        import contextlib
        import io
        import subprocess

        class TimingOutRunner:
            def __init__(self, *a, **kw):
                pass

            def rcon(self, server, command):
                raise subprocess.TimeoutExpired(
                    cmd=["ssh", "root@auraserver.eu", command], timeout=30)

            read_log = list_backups_raw = rcon

        old = lm.Runner
        lm.Runner = TimingOutRunner
        err = io.StringIO()
        try:
            with contextlib.redirect_stderr(err), contextlib.redirect_stdout(
                io.StringIO()
            ):
                rc = lm.main(["status", "1"])
        finally:
            lm.Runner = old
        self.assertEqual(rc, 1)
        self.assertIn("timed out", err.getvalue())
        self.assertIn("30", err.getvalue())


if __name__ == "__main__":
    unittest.main()


class TestMatchidInt32(unittest.TestCase):
    """MatchZy parses matchid as int32. Verified live: a YYMMDDHHMM stamp
    (2609192112) is all digits but overflows, and MatchZy answers
    'matchid should be an integer!' and refuses the config."""

    def test_rejects_matchid_over_int32(self):
        with self.assertRaises(lm.ConfigError) as cm:
            lm.validate_matchid("2609192112")
        self.assertIn("int32", str(cm.exception))

    def test_accepts_matchid_at_the_boundary(self):
        self.assertEqual(lm.validate_matchid("2147483647"), "2147483647")

    def test_default_matchid_fits_in_int32(self):
        # every month of a year, so the format cannot silently overflow later
        import datetime as _dt
        for month in range(1, 13):
            ts = _dt.datetime(2026, month, 28, 23, 59, tzinfo=_dt.timezone.utc).timestamp()
            mid = lm.default_matchid(ts)
            self.assertTrue(mid.isdigit())
            self.assertLessEqual(int(mid), lm.MATCHID_MAX, "overflow for month %d" % month)
            lm.validate_matchid(mid)  # must not raise


class TestLogPathWithSpaces(unittest.TestCase):
    """AMP names its logs 'AMPLOG_2026-09-19 21-11-31.log'. The space broke
    tail with 'cannot open ... No such file or directory' against the live
    server, so the command must not word-split the filename."""

    def test_tail_command_survives_a_space_in_the_filename(self):
        cmd = lm.read_newest_log_cmd("2")
        self.assertIn("-d '\\n'", cmd)
        self.assertIn("-I{}", cmd)


class TestBotSideIsExplicit(unittest.TestCase):
    """FACT 9, from a real bo3: Turbiini lost a player and the engine put the
    fill bot on heat, making it 6v4. `bot_quota_mode fill` tops the SERVER up
    to a head count and picks the side itself; mp_limitteams 0 (which every
    competitive config sets) means nothing stops it choosing the bigger team.
    So placement must be explicit, per side, and never inferred."""

    def test_normalise_side_accepts_either_case(self):
        for given, want in [("t", "t"), ("T", "t"), ("ct", "ct"), ("CT", "ct")]:
            self.assertEqual(lm.normalise_side(given), want)

    def test_normalise_side_refuses_anything_else(self):
        for bad in ["auto", "any", "", "terrorist", "1", None]:
            with self.assertRaises(ValueError):
                lm.normalise_side(bad)

    def test_add_leaves_fill_mode_before_adding(self):
        plan = lm.bot_add_plan("1", "t")
        commands = [s["command"] for s in plan["steps"]]
        self.assertIn("bot_quota_mode normal", commands)
        # and it must happen BEFORE the bot is added, or the add races the mode
        self.assertLess(
            commands.index("bot_quota_mode normal"), commands.index("bot_add_t")
        )

    def test_add_never_emits_fill_mode(self):
        for side in ("t", "ct"):
            for step in lm.bot_add_plan("1", side, count=3)["steps"]:
                self.assertNotIn("fill", step["command"])

    def test_add_places_the_bot_on_the_named_side_only(self):
        t_cmds = [s["command"] for s in lm.bot_add_plan("1", "t")["steps"]]
        self.assertIn("bot_add_t", t_cmds)
        self.assertNotIn("bot_add_ct", t_cmds)
        ct_cmds = [s["command"] for s in lm.bot_add_plan("1", "CT")["steps"]]
        self.assertIn("bot_add_ct", ct_cmds)
        self.assertNotIn("bot_add_t", ct_cmds)

    def test_add_disables_autoteambalance(self):
        cmds = [s["command"] for s in lm.bot_add_plan("2", "ct")["steps"]]
        self.assertIn("mp_autoteambalance 0", cmds)

    def test_count_controls_how_many_bots(self):
        for n in (1, 2, 5):
            cmds = [s["command"] for s in lm.bot_add_plan("1", "t", count=n)["steps"]]
            self.assertEqual(cmds.count("bot_add_t"), n)

    def test_count_outside_one_to_five_is_refused(self):
        for bad in (0, -1, 6, 11):
            with self.assertRaises(ValueError):
                lm.bot_add_plan("1", "t", count=bad)

    def test_default_difficulty_is_expert(self):
        cmds = [s["command"] for s in lm.bot_add_plan("1", "t")["steps"]]
        self.assertIn("bot_difficulty 3", cmds)

    def test_difficulty_outside_zero_to_three_is_refused(self):
        for bad in (-1, 4):
            with self.assertRaises(ValueError):
                lm.bot_add_plan("1", "t", difficulty=bad)

    def test_kick_can_target_one_side(self):
        self.assertEqual(
            [s["command"] for s in lm.bot_kick_plan("1", "t")["steps"]], ["bot_kick t"]
        )
        self.assertEqual(
            [s["command"] for s in lm.bot_kick_plan("1", "CT")["steps"]],
            ["bot_kick ct"],
        )

    def test_kick_with_no_side_kicks_all(self):
        self.assertEqual(
            [s["command"] for s in lm.bot_kick_plan("1")["steps"]], ["bot_kick"]
        )


class TestBotIsAllowedDuringALiveMatch(unittest.TestCase):
    """A player disconnects mid-round; that is the ONLY time `bot` is wanted.
    Refusing it while live would make --force the normal way to run it, which
    defeats every other refusal in the tool."""

    LIVE = {
        "server": "1",
        "map": "de_nuke",
        "humans": 9,
        "rounds_played": 14,
        "config_loaded": True,
        "matchid": "9141800",
    }

    def test_bot_is_allowed_while_live_without_force(self):
        decision = lm.check_safety("bot", dict(self.LIVE), force=False)
        self.assertTrue(decision.allowed)

    def test_bot_says_why_it_is_proceeding(self):
        decision = lm.check_safety("bot", dict(self.LIVE), force=False)
        self.assertTrue(any("live" in w.lower() for w in decision.warnings))

    def test_load_is_still_refused_while_live(self):
        decision = lm.check_safety("load", dict(self.LIVE), force=False)
        self.assertFalse(decision.allowed)

    def test_bot_still_refuses_when_liveness_is_unknown(self):
        unknown = {"server": "1", "map": None, "humans": 0,
                   "rounds_played": None, "config_loaded": None}
        self.assertFalse(lm.check_safety("bot", unknown, force=False).allowed)


class TestNoSteamIdsNeeded(unittest.TestCase):
    """The organiser must not have to collect ten SteamIDs before a match.
    Unknown team names produce EMPTY rosters, which is the mode MatchZy kicks
    nobody in; the plugin works the teams out from the sides at match start."""

    def test_unknown_team_names_give_empty_rosters(self):
        reg = {"rosters": {"regulars": {"76561198000000001": "Tomppa"}}}
        self.assertEqual(lm.roster_players(reg, "some team from the door"), {})

    def test_a_config_with_two_unknown_names_is_accepted(self):
        reg = {"rosters": {}}
        cfg = lm.build_match_config(
            "9201200",
            "heat", lm.roster_players(reg, "heat"),
            "Turbiini", lm.roster_players(reg, "Turbiini"),
            ["de_nuke"],
        )
        self.assertEqual(cfg["team1"]["players"], {})
        self.assertEqual(cfg["team2"]["players"], {})
        self.assertEqual(cfg["team1"]["name"], "heat")
        self.assertEqual(cfg["team2"]["name"], "Turbiini")

    def test_the_note_says_empty_rosters_are_normal(self):
        cfg = lm.build_match_config(
            "9201200", "heat", {}, "Turbiini", {}, ["de_nuke"]
        )
        note = lm.config_side_note(cfg)
        self.assertIn("EMPTY", note)
        self.assertIn("kicks nobody", note)

    def test_the_note_stays_quiet_when_rosters_are_used(self):
        players = {"76561198000000001": "A", "76561198000000002": "B"}
        cfg = lm.build_match_config(
            "9201200", "heat", dict(players), "Turbiini", dict(players2 := {
                "76561198000000003": "C", "76561198000000004": "D"}),
            ["de_nuke"], players_per_team=2,
        )
        self.assertNotIn("EMPTY", lm.config_side_note(cfg))


class TestBridgeRefusals(unittest.TestCase):
    """The bridge drains lahtiag.fi's queue onto the servers, because a
    Cloudflare Worker has no route to them. The load is the destructive
    step — matchzy_loadmatch over an autostarted live match silently
    destroys it — so it is the refusals that matter here."""

    LIVE = {"server": "1", "map": "de_nuke", "humans": 10,
            "rounds_played": 14, "config_loaded": True, "matchid": "12"}
    IDLE = {"server": "1", "map": "de_dust2", "humans": 0,
            "rounds_played": -1, "config_loaded": False, "matchid": None}
    WITH_PLAYERS = {"server": "1", "map": "de_dust2", "humans": 8,
                    "rounds_played": -1, "config_loaded": False, "matchid": None}
    UNKNOWN = {"server": "1", "map": None, "humans": 0,
               "rounds_played": None, "config_loaded": None, "matchid": None}

    def test_refuses_to_load_over_a_live_match(self):
        ok, why = lm.bridge_should_load(dict(self.LIVE))
        self.assertFalse(ok)
        self.assertIn("live", why)

    def test_refuses_when_liveness_is_unknown(self):
        # The unknown IS the case that destroyed a live game.
        ok, why = lm.bridge_should_load(dict(self.UNKNOWN))
        self.assertFalse(ok)

    def test_loads_onto_an_idle_server(self):
        self.assertTrue(lm.bridge_should_load(dict(self.IDLE))[0])

    def test_connected_players_do_not_block_a_load(self):
        # The site's configs carry EMPTY rosters, so MatchZy kicks nobody;
        # players already on the server is the normal case, not a hazard.
        self.assertTrue(lm.bridge_should_load(dict(self.WITH_PLAYERS))[0])


class TestBridgeSetup(unittest.TestCase):
    def test_points_the_server_at_the_site(self):
        commands = [s["command"] for s in lm.bridge_setup_plan("1", "https://lahtiag.fi/", "sekret")["steps"]]
        self.assertIn('matchzy_match_token "sekret"', commands)
        self.assertIn('matchzy_remote_log_url "https://lahtiag.fi/api/cs2/events"', commands)

    def test_a_trailing_slash_does_not_double_up(self):
        for site in ("https://lahtiag.fi", "https://lahtiag.fi/"):
            commands = [s["command"] for s in lm.bridge_setup_plan("1", site, "t")["steps"]]
            self.assertIn('matchzy_remote_log_url "https://lahtiag.fi/api/cs2/events"', commands)
