using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes.Registration;
using CounterStrikeSharp.API.Modules.Admin;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Cvars;
using CounterStrikeSharp.API.Modules.Utils;

namespace LahtiAGTeams;

// ---------------------------------------------------------------------------
// LahtiAGTeams
//
// Purpose: at a LAN tournament we want players to land back on the right side
// automatically, WITHOUT anybody having collected their SteamIDs first, and we
// want people who are not in the match left completely alone.
//
// So the teams are not configured, they are observed: whoever is on CT when
// the match goes live is team 1 and whoever is on T is team 2. That is the
// match everyone just readied up for, so it is right by definition, and it
// costs the organiser nothing. A configured roster still exists for regulars
// you want recognised during warmup, but it is optional and normally empty. MatchZy can pin players to teams via a match config, but the moment
// you give it a roster it starts kicking everybody who is not on it
// ("KICKING PLAYER ... NOT ALLOWED!"). That kicked a legitimate player
// repeatedly during a tournament and later emptied a whole server.
//
// So: MatchZy runs with EMPTY rosters (it therefore kicks nobody) and this
// plugin does the assignment. THIS PLUGIN NEVER KICKS A PLAYER. There is
// deliberately no call to any kick/ban API anywhere in this file, and the
// only removal it performs is `bot_kick <side>`, which the engine applies to
// bots alone and can never touch a human.
// ---------------------------------------------------------------------------

public class LahtiAGTeamsConfig : BasePluginConfig
{
    /// <summary>Master switch. If false the plugin observes and moves nobody.</summary>
    [JsonPropertyName("Enabled")]
    public bool Enabled { get; set; } = true;

    /// <summary>
    /// OPTIONAL. Team name -> list of SteamID64 strings, e.g.
    /// { "Alpha": ["76561198...", ...] }.
    ///
    /// You do not need this. Collecting ten SteamIDs before a match is exactly
    /// the friction we are trying to remove, and it is why MatchZy's own roster
    /// is unusable at a walk-in LAN. Leave it empty and LearnTeamsAtMatchStart
    /// works the teams out by itself. Fill it in only for regulars you want
    /// recognised before a match has started (during warmup, say) — an entry
    /// here always wins over a learned one.
    /// </summary>
    [JsonPropertyName("Teams")]
    public Dictionary<string, List<string>> Teams { get; set; } = new();

    /// <summary>Tell the player in chat when we move them.</summary>
    [JsonPropertyName("AnnounceMoves")]
    public bool AnnounceMoves { get; set; } = true;

    /// <summary>
    /// If true, only move a player while the match is not live (warmup), or while the
    /// player is unassigned/spectating. Prevents yanking somebody across teams mid-round.
    /// </summary>
    [JsonPropertyName("OnlyWhenNotLive")]
    public bool OnlyWhenNotLive { get; set; } = true;

    /// <summary>
    /// Work out who is on which team by looking at the sides when the match
    /// goes live, instead of being told in advance.
    ///
    /// Whoever is on CT when the first non-warmup round starts is team 1, and
    /// whoever is on T is team 2. That is true by definition: it is the match
    /// everybody just readied up for. From then on those players are followed
    /// through halftime, reconnects and knife-round switches without anyone
    /// having typed a SteamID anywhere.
    ///
    /// Re-learned at the start of every match, so map 2 of a bo3 and the next
    /// pair of teams entirely both sort themselves out.
    /// </summary>
    [JsonPropertyName("LearnTeamsAtMatchStart")]
    public bool LearnTeamsAtMatchStart { get; set; } = true;

    /// <summary>
    /// Stand a bot in for a missing player, ON THE SIDE THAT IS SHORT.
    ///
    /// OFF by default, deliberately. The previous attempt at this was
    /// `bot_quota_mode fill` in cfg/MatchZy/live_override.cfg, on the
    /// assumption that fill puts the bot wherever the gap is. It does not:
    /// fill keeps the TOTAL head count at bot_quota and lets the engine
    /// choose the side, and with mp_limitteams 0 nothing stops it choosing
    /// the side that is already bigger. In a real bo3 one team lost a player
    /// and the bot joined the OTHER team: 6v4. This replaces that with an
    /// explicit per-side count, but it has not yet been exercised with real
    /// players, so it stays off until it has been.
    /// </summary>
    [JsonPropertyName("BotFill")]
    public bool BotFill { get; set; } = false;

    /// <summary>0 = easy .. 3 = expert. A weak stand-in loses the round anyway.</summary>
    [JsonPropertyName("BotFillDifficulty")]
    public int BotFillDifficulty { get; set; } = 3;

    /// <summary>Hard ceiling on stand-ins per side, so a bug cannot flood a server.</summary>
    [JsonPropertyName("BotFillMaxPerSide")]
    public int BotFillMaxPerSide { get; set; } = 2;
}

public class LahtiAGTeams : BasePlugin, IPluginConfig<LahtiAGTeamsConfig>
{
    public override string ModuleName => "LahtiAGTeams";
    public override string ModuleVersion => "1.0.0";
    public override string ModuleAuthor => "LahtiAG";
    public override string ModuleDescription =>
        "Auto-assigns known players to their team's current side. Never kicks anyone.";

    public LahtiAGTeamsConfig Config { get; set; } = new();

    private static readonly string ChatPrefix = $" {ChatColors.Green}[LahtiAG]{ChatColors.Default} ";

    /// <summary>How long we ignore team events for a slot after we moved that slot.</summary>
    private const double MoveSuppressionSeconds = 3.0;

    /// <summary>Delay before acting on a connect/team event, so the engine settles first.</summary>
    private const float ActionDelaySeconds = 1.0f;

    /// <summary>SteamID64 -> team name. Rebuilt from Config.Teams on every (re)load.</summary>
    private readonly Dictionary<ulong, string> _steamIdToTeam = new();

    /// <summary>
    /// SteamID64 -> team name, worked out from the sides at match start rather
    /// than configured. Config.Teams always wins over this.
    /// </summary>
    private readonly Dictionary<ulong, string> _learnedTeam = new();

    /// <summary>Set once per match, so we learn at the first live round and not every round.</summary>
    private bool _learnedThisMatch;

    // -----------------------------------------------------------------------
    // LOOP GUARD
    //
    // Calling SwitchTeam/ChangeTeam makes the engine fire player_team, which is
    // the very event we listen to. Without a guard, our own move re-enters the
    // handler, we recompute, and in edge cases (e.g. two teammates split across
    // sides) we can ping-pong a player back and forth forever.
    //
    // So every slot we move is stamped here with an expiry timestamp. Any team
    // event for a suppressed slot is ignored until the stamp expires. The window
    // is a few seconds, which comfortably covers the engine's own follow-up
    // events plus our own deferred timers, and is short enough that a real
    // player choosing a team by hand right after is still handled.
    // -----------------------------------------------------------------------
    private readonly Dictionary<int, DateTime> _suppressedUntil = new();

    public void OnConfigParsed(LahtiAGTeamsConfig config)
    {
        Config = config;
        RebuildIndex();
    }

    public override void Load(bool hotReload)
    {
        Logger.LogInformation(
            "LahtiAGTeams loaded. Enabled={0}, configured teams={1} ({2} player(s) - optional), LearnTeamsAtMatchStart={3}, BotFill={4}. This plugin never kicks a player.",
            Config.Enabled, Config.Teams.Count, _steamIdToTeam.Count, Config.LearnTeamsAtMatchStart, Config.BotFill);
    }

    private void RebuildIndex()
    {
        _steamIdToTeam.Clear();
        foreach (var (teamName, members) in Config.Teams)
        {
            foreach (var raw in members)
            {
                if (string.IsNullOrWhiteSpace(raw)) continue;
                if (!ulong.TryParse(raw.Trim(), out var steamId) || steamId == 0)
                {
                    Logger.LogWarning("Ignoring unparseable SteamID64 '{0}' in team '{1}'.", raw, teamName);
                    continue;
                }

                if (_steamIdToTeam.TryGetValue(steamId, out var existing) && existing != teamName)
                {
                    Logger.LogWarning(
                        "SteamID {0} is listed in both '{1}' and '{2}'; keeping '{3}'.",
                        steamId, existing, teamName, existing);
                    continue;
                }

                _steamIdToTeam[steamId] = teamName;
            }
        }
    }

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    [GameEventHandler]
    public HookResult OnPlayerConnectFull(EventPlayerConnectFull @event, GameEventInfo info)
    {
        var player = @event.Userid;
        if (!IsRealPlayer(player)) return HookResult.Continue;

        var slot = player!.Slot;
        // Defer: on connect the controller is not fully set up and the SteamID may
        // not be authorized yet. Re-resolve the controller from the slot in the timer.
        AddTimer(ActionDelaySeconds, () => TryAssignBySlot(slot));
        return HookResult.Continue;
    }

    [GameEventHandler]
    public HookResult OnPlayerTeam(EventPlayerTeam @event, GameEventInfo info)
    {
        var player = @event.Userid;

        // A player_team with Disconnect=true is the leave event; just clean up.
        if (@event.Disconnect)
        {
            if (player != null && player.IsValid) _suppressedUntil.Remove(player.Slot);
            return HookResult.Continue;
        }

        if (!IsRealPlayer(player)) return HookResult.Continue;

        var slot = player!.Slot;

        // Loop guard: this event may well be the echo of our own move.
        if (IsSuppressed(slot)) return HookResult.Continue;

        AddTimer(ActionDelaySeconds, () => TryAssignBySlot(slot));
        // Somebody just took a side; if a bot was covering for them, drop it now.
        AddTimer(ActionDelaySeconds, RemoveSurplusBots);
        return HookResult.Continue;
    }

    [GameEventHandler]
    public HookResult OnPlayerDisconnect(EventPlayerDisconnect @event, GameEventInfo info)
    {
        var player = @event.Userid;
        if (player != null && player.IsValid) _suppressedUntil.Remove(player.Slot);

        // The counts are only right once the engine has actually removed them.
        AddTimer(ActionDelaySeconds, RebalanceBots);
        return HookResult.Continue;
    }

    /// <summary>
    /// Round start is where bots are ADDED. A bot spawned mid-round arrives
    /// dead or out of position and is worth nothing to the side that is short,
    /// so the fill waits for the natural boundary. Removal does not wait (see
    /// OnPlayerTeam): a surplus bot standing next to the player it was
    /// covering for is worse than a brief gap.
    /// </summary>
    [GameEventHandler]
    public HookResult OnRoundStart(EventRoundStart @event, GameEventInfo info)
    {
        AddTimer(ActionDelaySeconds, OnLiveRoundStarted);
        AddTimer(ActionDelaySeconds, RebalanceBots);
        return HookResult.Continue;
    }

    /// <summary>
    /// Learn the teams at the first round of the match that is not warmup, and
    /// arm the next match to be learned again once we are back in warmup.
    /// </summary>
    private void OnLiveRoundStarted()
    {
        if (!Config.Enabled || !Config.LearnTeamsAtMatchStart) return;

        var warmup = IsWarmup();
        if (warmup != false)
        {
            // Warmup (or unreadable): this is the run-up to a match, so the
            // next live round is a match start worth learning from. The teams
            // we already know are KEPT until we have something to replace them
            // with — forgetting them here would strand a player who reconnects
            // during warmup.
            if (warmup == true) _learnedThisMatch = false;
            return;
        }

        if (_learnedThisMatch) return;
        _learnedThisMatch = true;
        LearnTeamsFromSides();
    }

    // -----------------------------------------------------------------------
    // Assignment
    // -----------------------------------------------------------------------

    private void TryAssignBySlot(int slot)
    {
        if (!Config.Enabled) return;

        // The player may have disconnected during the delay; re-resolve and re-validate.
        var player = Utilities.GetPlayerFromSlot(slot);
        if (!IsRealPlayer(player)) return;

        TryAssign(player!);
    }

    private void TryAssign(CCSPlayerController player)
    {
        if (IsSuppressed(player.Slot)) return;

        var steamId = GetSteamId(player);
        if (steamId == 0) return;

        // Not on any configured roster => this player is none of our business.
        // Unknown players are never touched, never moved, never kicked.
        if (!TryGetTeam(steamId, out var teamName)) return;

        var desired = ResolveSideFromTeammates(teamName, steamId);

        // No teammate is currently on a playing side => we have nothing to follow.
        // Do NOT guess; leave the player wherever they are.
        if (desired == CsTeam.None) return;

        var current = player.Team;
        if (current == desired) return;

        if (!MayMoveNow(player, current))
        {
            Logger.LogInformation(
                "Not moving {0} ({1}) to {2} right now: match is live and player is on a playing side.",
                player.PlayerName, teamName, SideName(desired));
            return;
        }

        Move(player, desired, teamName, current);
    }

    /// <summary>
    /// THE HALFTIME RULE.
    ///
    /// We deliberately do NOT keep a fixed "team Alpha = CT" mapping. Sides swap at
    /// halftime (and on knife-round swaps, and when admins swap manually), and a stale
    /// fixed mapping is exactly what made MatchZy drag people to the wrong side over
    /// and over. Instead we look at where this player's *already connected* teammates
    /// are standing right now and follow the majority. After a halftime swap the
    /// teammates are on the other side, so the answer flips by itself with zero config
    /// changes and zero knowledge of the scoreboard.
    ///
    /// Returns CsTeam.None when there is nothing to follow (no teammates in game) or
    /// when the teammates are evenly split between the two sides (ambiguous -> do not
    /// guess).
    /// </summary>
    private CsTeam ResolveSideFromTeammates(string teamName, ulong selfSteamId)
    {
        var ct = 0;
        var t = 0;

        foreach (var other in Utilities.GetPlayers())
        {
            if (!IsRealPlayer(other)) continue;

            var otherSteamId = GetSteamId(other);
            if (otherSteamId == 0 || otherSteamId == selfSteamId) continue;

            if (!TryGetTeam(otherSteamId, out var otherTeam)) continue;
            if (!string.Equals(otherTeam, teamName, StringComparison.Ordinal)) continue;

            // Only teammates actually on a playing side count. Spectators and
            // unassigned teammates tell us nothing about which side the team holds.
            switch (other.Team)
            {
                case CsTeam.CounterTerrorist: ct++; break;
                case CsTeam.Terrorist: t++; break;
            }
        }

        if (ct > t) return CsTeam.CounterTerrorist;
        if (t > ct) return CsTeam.Terrorist;
        return CsTeam.None; // 0-0 (nobody to follow) or an even split (ambiguous).
    }

    /// <summary>
    /// OnlyWhenNotLive gate. We allow a move when:
    ///  - the option is off, or
    ///  - the player is currently unassigned or spectating (they are not in the round,
    ///    so moving them disturbs nothing), or
    ///  - the match is demonstrably in warmup.
    /// If we cannot read the game rules entity at all we deliberately fail closed and
    /// refuse to move a player who is on a playing side.
    /// </summary>
    private bool MayMoveNow(CCSPlayerController player, CsTeam current)
    {
        if (!Config.OnlyWhenNotLive) return true;
        if (current is CsTeam.None or CsTeam.Spectator) return true;

        var warmup = IsWarmup();
        return warmup == true;
    }

    /// <summary>
    /// "Live" detection: read m_bWarmupPeriod off the cs_gamerules entity.
    /// Returns null when the entity cannot be found/read, so callers can fail closed.
    /// </summary>
    private static bool? IsWarmup()
    {
        try
        {
            foreach (var proxy in Utilities.FindAllEntitiesByDesignerName<CCSGameRulesProxy>("cs_gamerules"))
            {
                if (proxy == null || !proxy.IsValid) continue;
                var rules = proxy.GameRules;
                if (rules == null) continue;
                return rules.WarmupPeriod;
            }
        }
        catch
        {
            // Schema/entity access can throw on map change; treat as "unknown".
        }

        return null;
    }

    private void Move(CCSPlayerController player, CsTeam desired, string teamName, CsTeam current)
    {
        // Arm the loop guard BEFORE the move, because the engine fires player_team
        // synchronously from inside the call below.
        Suppress(player.Slot);

        if (current is CsTeam.None or CsTeam.Spectator)
        {
            // ChangeTeam: the plain controller-level team change. The player is not in
            // play (unassigned/spectating), so there is nothing to kill and nothing to
            // respawn; this is the least disruptive way in.
            player.ChangeTeam(desired);
        }
        else
        {
            // SwitchTeam: the CS2-specific team switch. Unlike ChangeTeam it keeps the
            // player/pawn state consistent when moving between two playing sides
            // (scoreboard, money services, pawn ownership). ChangeTeam between T and CT
            // can leave a live pawn attached to the old side.
            player.SwitchTeam(desired);
        }

        Logger.LogInformation(
            "Moved {0} [{1}] from {2} to {3} (team '{4}', following teammates).",
            player.PlayerName, GetSteamId(player), SideName(current), SideName(desired), teamName);

        if (Config.AnnounceMoves)
        {
            player.PrintToChat(
                $"{ChatPrefix}You are on team {ChatColors.Gold}{teamName}{ChatColors.Default}" +
                $" - moved to {ChatColors.Gold}{SideName(desired)}{ChatColors.Default} with your teammates.");
        }
    }

    // -----------------------------------------------------------------------
    // WHO IS ON WHICH TEAM
    //
    // The configured roster is optional and usually empty. Requiring ten
    // SteamIDs before a match is the friction this plugin exists to remove, so
    // the normal path is to learn the teams from the sides at match start.
    // -----------------------------------------------------------------------

    /// <summary>Configured roster first, then whatever we learned at match start.</summary>
    private bool TryGetTeam(ulong steamId, out string teamName)
    {
        if (_steamIdToTeam.TryGetValue(steamId, out var configured))
        {
            teamName = configured;
            return true;
        }

        return _learnedTeam.TryGetValue(steamId, out teamName!);
    }

    /// <summary>
    /// Snapshot the sides as the teams for this match.
    ///
    /// Called at the start of the first non-warmup round. At that instant CT is
    /// mp_teamname_1 and T is mp_teamname_2 by MatchZy's own definition, so the
    /// names line up with the scoreboard without us tracking the swap.
    ///
    /// Only the LEARNED map is replaced; a configured roster is left alone.
    /// </summary>
    private void LearnTeamsFromSides()
    {
        var ct = TeamNameCvar(1, "Team 1");
        var t = TeamNameCvar(2, "Team 2");

        var learned = new Dictionary<ulong, string>();
        foreach (var player in Utilities.GetPlayers())
        {
            if (!IsRealPlayer(player)) continue;

            var steamId = GetSteamId(player);
            if (steamId == 0) continue;

            var name = player!.Team switch
            {
                CsTeam.CounterTerrorist => ct,
                CsTeam.Terrorist => t,
                _ => null, // spectators and the unassigned are on no team yet
            };

            if (name != null) learned[steamId] = name;
        }

        // Nobody is playing: this is not a match start we can learn anything
        // from, so keep what we had rather than forgetting everyone.
        if (learned.Count == 0) return;

        _learnedTeam.Clear();
        foreach (var (id, name) in learned) _learnedTeam[id] = name;

        Logger.LogInformation(
            "Learned teams from the sides at match start: {0} player(s), '{1}' on CT and '{2}' on T. No SteamIDs were configured for them.",
            _learnedTeam.Count, ct, t);
    }

    private static string TeamNameCvar(int number, string fallback)
    {
        try
        {
            var value = ConVar.Find($"mp_teamname_{number}")?.StringValue;
            if (!string.IsNullOrWhiteSpace(value) && value != "unnamed") return value!;
        }
        catch
        {
            // Cvar not present on this build; the fallback is only a label.
        }

        return fallback;
    }

    // -----------------------------------------------------------------------
    // BOT FILL
    //
    // The rule is one line: each side should end up with as many players as
    // the fuller side has, and a bot is only ever added to a side we NAMED.
    // Nothing here asks the engine to work out where the gap is, because that
    // is precisely what got it wrong (see LahtiAGTeamsConfig.BotFill).
    // -----------------------------------------------------------------------

    /// <summary>Debounce: disconnect, player_team and round_start can all fire together.</summary>
    private DateTime _lastBotAction = DateTime.MinValue;
    private const double BotActionCooldownSeconds = 1.5;

    private bool BotFillReady()
    {
        if (!Config.Enabled || !Config.BotFill) return false;

        // Fail closed. Warmup fills itself with whoever wanders in, and an
        // unreadable game-rules entity (map change) means we know nothing.
        if (IsWarmup() != false) return false;

        if ((DateTime.UtcNow - _lastBotAction).TotalSeconds < BotActionCooldownSeconds) return false;
        _lastBotAction = DateTime.UtcNow;
        return true;
    }

    /// <summary>Humans and bots currently on each playing side.</summary>
    private (int humans, int bots) CountSide(CsTeam side)
    {
        var humans = 0;
        var bots = 0;
        foreach (var p in Utilities.GetPlayers())
        {
            try
            {
                if (p == null || !p.IsValid || p.IsHLTV) continue;
                if (p.Team != side) continue;
                if (p.IsBot) bots++;
                else if (p.Connected == PlayerConnectedState.Connected) humans++;
            }
            catch
            {
                // Freed handle mid-iteration; it is not on any side as far as we care.
            }
        }

        return (humans, bots);
    }

    /// <summary>Kick bots on any side that no longer needs them. Never adds.</summary>
    private void RemoveSurplusBots()
    {
        if (!BotFillReady()) return;
        Apply(addAllowed: false);
    }

    /// <summary>Kick surplus bots and add stand-ins so both sides match.</summary>
    private void RebalanceBots()
    {
        if (!BotFillReady()) return;
        Apply(addAllowed: true);
    }

    private void Apply(bool addAllowed)
    {
        var ct = CountSide(CsTeam.CounterTerrorist);
        var t = CountSide(CsTeam.Terrorist);

        // Nobody is playing (between maps, or an empty server): do nothing at
        // all rather than filling an idle server with bots.
        if (ct.humans == 0 && t.humans == 0) return;

        // The fuller side defines what a full team looks like right now. We
        // never invent a target from players_per_team: a deliberate 4v4 scrim
        // should stay a 4v4, not become a 5v5 with two bots in it.
        var target = Math.Max(ct.humans, t.humans);

        Fix(CsTeam.CounterTerrorist, ct, target, addAllowed);
        Fix(CsTeam.Terrorist, t, target, addAllowed);
    }

    private void Fix(CsTeam side, (int humans, int bots) now, int target, bool addAllowed)
    {
        var wanted = Math.Clamp(target - now.humans, 0, Math.Max(0, Config.BotFillMaxPerSide));
        if (wanted == now.bots) return;

        var name = SideName(side);

        if (now.bots > wanted)
        {
            // bot_kick <side> removes every bot on that side; we put the
            // wanted number straight back. Kicking one specific bot means
            // naming it, and bot names are not stable enough to rely on.
            Server.ExecuteCommand($"bot_kick {name.ToLowerInvariant()}");
            Logger.LogInformation(
                "BotFill: {0} had {1} bot(s) for {2} human(s) against a target of {3} -> kicked every bot on that side.",
                name, now.bots, now.humans, target);
            now = (now.humans, 0);
        }

        if (!addAllowed || wanted <= now.bots) return;

        // bot_quota_mode must be `normal` for this to mean anything: in `fill`
        // mode bot_quota is a server-wide head count and the engine re-picks
        // the sides behind us. cfg/MatchZy/live_override.cfg sets it, but set
        // it here too so the plugin does not depend on a file it does not own.
        Server.ExecuteCommand("bot_quota_mode normal");
        Server.ExecuteCommand("mp_autoteambalance 0");
        Server.ExecuteCommand($"bot_difficulty {Math.Clamp(Config.BotFillDifficulty, 0, 3)}");

        var add = wanted - now.bots;
        var command = side == CsTeam.CounterTerrorist ? "bot_add_ct" : "bot_add_t";
        for (var i = 0; i < add; i++) Server.ExecuteCommand(command);

        Logger.LogInformation(
            "BotFill: {0} has {1} human(s) against a target of {2} -> added {3} bot(s) with {4}.",
            name, now.humans, target, add, command);
    }

    // -----------------------------------------------------------------------
    // Loop guard helpers
    // -----------------------------------------------------------------------

    private void Suppress(int slot) =>
        _suppressedUntil[slot] = DateTime.UtcNow.AddSeconds(MoveSuppressionSeconds);

    private bool IsSuppressed(int slot)
    {
        if (!_suppressedUntil.TryGetValue(slot, out var until)) return false;
        if (DateTime.UtcNow < until) return true;
        _suppressedUntil.Remove(slot);
        return false;
    }

    // -----------------------------------------------------------------------
    // Commands
    // -----------------------------------------------------------------------

    [ConsoleCommand("css_lagteams", "Show the configured teams and who from each is connected")]
    public void OnTeamsCommand(CCSPlayerController? caller, CommandInfo command)
    {
        command.ReplyToCommand($"[LahtiAGTeams] Enabled={Config.Enabled} OnlyWhenNotLive={Config.OnlyWhenNotLive} AnnounceMoves={Config.AnnounceMoves}");
        command.ReplyToCommand($"[LahtiAGTeams] BotFill={Config.BotFill} (difficulty {Config.BotFillDifficulty}, max {Config.BotFillMaxPerSide}/side)");
        command.ReplyToCommand($"[LahtiAGTeams] LearnTeamsAtMatchStart={Config.LearnTeamsAtMatchStart} learnedThisMatch={_learnedThisMatch}");

        var warmup = IsWarmup();
        command.ReplyToCommand($"[LahtiAGTeams] Warmup: {(warmup.HasValue ? warmup.Value.ToString() : "unknown")}");

        // SteamID64 -> connected controller, for the roster printout.
        var connected = new Dictionary<ulong, CCSPlayerController>();
        foreach (var p in Utilities.GetPlayers())
        {
            if (!IsRealPlayer(p)) continue;
            var sid = GetSteamId(p);
            if (sid != 0) connected[sid] = p;
        }

        if (_learnedTeam.Count > 0)
        {
            command.ReplyToCommand($"[LahtiAGTeams] Learned from the sides at match start ({_learnedTeam.Count}):");
            foreach (var (sid, teamName) in _learnedTeam)
            {
                var who = connected.TryGetValue(sid, out var p)
                    ? $"{p.PlayerName} [{SideName(p.Team)}]"
                    : "(not connected)";
                command.ReplyToCommand($"  - {teamName}: {who}");
            }
        }
        else
        {
            command.ReplyToCommand("[LahtiAGTeams] Nothing learned yet (no match has gone live since load).");
        }

        if (Config.Teams.Count == 0)
        {
            command.ReplyToCommand("[LahtiAGTeams] No teams configured - that is the normal case; teams are learned, not listed.");
            return;
        }

        foreach (var (teamName, members) in Config.Teams)
        {
            command.ReplyToCommand($"[LahtiAGTeams] {teamName} ({members.Count} listed):");
            foreach (var raw in members)
            {
                if (!ulong.TryParse((raw ?? string.Empty).Trim(), out var sid) || sid == 0)
                {
                    command.ReplyToCommand($"  - {raw} (invalid SteamID64)");
                    continue;
                }

                if (connected.TryGetValue(sid, out var p))
                    command.ReplyToCommand($"  - {sid} {p.PlayerName} [{SideName(p.Team)}]");
                else
                    command.ReplyToCommand($"  - {sid} (not connected)");
            }
        }
    }

    [RequiresPermissions("@css/config")]
    [ConsoleCommand("css_lagteams_reload", "Reload the LahtiAGTeams config from disk")]
    public void OnReloadCommand(CCSPlayerController? caller, CommandInfo command)
    {
        var path = FindConfigPath();
        if (path == null)
        {
            command.ReplyToCommand("[LahtiAGTeams] Could not locate LahtiAGTeams.json on disk.");
            return;
        }

        try
        {
            var json = File.ReadAllText(path);
            var options = new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true,
                ReadCommentHandling = JsonCommentHandling.Skip,
                AllowTrailingCommas = true,
            };

            var parsed = JsonSerializer.Deserialize<LahtiAGTeamsConfig>(json, options);
            if (parsed == null)
            {
                command.ReplyToCommand("[LahtiAGTeams] Config file parsed to null; keeping current config.");
                return;
            }

            Config = parsed;
            RebuildIndex();
            command.ReplyToCommand(
                $"[LahtiAGTeams] Reloaded {Config.Teams.Count} team(s), {_steamIdToTeam.Count} known player(s) from {path}");
        }
        catch (Exception ex)
        {
            // Keep the previous config on any failure - a broken file must never
            // leave us with an empty roster mid-tournament.
            command.ReplyToCommand($"[LahtiAGTeams] Reload failed, keeping current config: {ex.Message}");
            Logger.LogError(ex, "LahtiAGTeams config reload failed.");
        }
    }

    /// <summary>
    /// The generated config lives at
    /// addons/counterstrikesharp/configs/plugins/LahtiAGTeams/LahtiAGTeams.json.
    /// ModuleDirectory is addons/counterstrikesharp/plugins/LahtiAGTeams, so we walk up.
    /// </summary>
    private string? FindConfigPath()
    {
        var candidates = new[]
        {
            Path.GetFullPath(Path.Combine(ModuleDirectory, "..", "..", "configs", "plugins", "LahtiAGTeams", "LahtiAGTeams.json")),
            Path.GetFullPath(Path.Combine(ModuleDirectory, "..", "..", "..", "configs", "plugins", "LahtiAGTeams", "LahtiAGTeams.json")),
        };

        return candidates.FirstOrDefault(File.Exists);
    }

    // -----------------------------------------------------------------------
    // Small helpers
    // -----------------------------------------------------------------------

    /// <summary>Valid, connected, human (no bots, no HLTV/GOTV proxy).</summary>
    private static bool IsRealPlayer(CCSPlayerController? player)
    {
        if (player == null) return false;
        try
        {
            if (!player.IsValid) return false;
            if (player.IsBot || player.IsHLTV) return false;
            if (player.Connected != PlayerConnectedState.Connected) return false;
        }
        catch
        {
            // An invalid/freed handle can throw on property access; treat as not real.
            return false;
        }

        return true;
    }

    private static ulong GetSteamId(CCSPlayerController player)
    {
        try
        {
            var authorized = player.AuthorizedSteamID;
            if (authorized != null && authorized.SteamId64 != 0) return authorized.SteamId64;
            return player.SteamID;
        }
        catch
        {
            return 0;
        }
    }

    private static string SideName(CsTeam team) => team switch
    {
        CsTeam.CounterTerrorist => "CT",
        CsTeam.Terrorist => "T",
        CsTeam.Spectator => "SPEC",
        _ => "NONE",
    };
}
