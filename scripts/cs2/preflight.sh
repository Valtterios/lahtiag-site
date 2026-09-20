#!/bin/bash
# Pre-event verification for the LahtiAG CS2 servers.
#
# Run this DAYS before an event, not an hour before. Every failure it checks
# for has actually happened: a Metamod auto-update silently stopped
# CounterStrikeSharp from loading (so MatchZy vanished and the server looked
# fine), a CS2 update reverted cfg/server.cfg because it is a depot file, and
# a dead GSLT let the server run while never logging into Steam.
#
# Usage:  preflight.sh [--keep-running]
# Runs on the AMP host as root.

set -u
KEEP=0
[ "${1:-}" = "--keep-running" ] && KEEP=1

PASS=0; FAIL=0; WARN=0
ok()   { echo "  PASS  $*"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $*"; FAIL=$((FAIL+1)); }
warn() { echo "  WARN  $*"; WARN=$((WARN+1)); }

POOL="de_ancient de_anubis de_dust2 de_inferno de_mirage de_nuke de_overpass"
PUBIP=$(curl -s -m 10 https://api.ipify.org)

a2s() { # host port -> prints "name|map" or nothing
  python3 - "$1" "$2" <<'PY'
import socket, sys
h, p = sys.argv[1], int(sys.argv[2])
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(6)
try:
    s.sendto(b"\xff\xff\xff\xffTSource Engine Query\x00", (h, p))
    d, _ = s.recvfrom(4096)
    if d[4:5] == b"A":
        s.sendto(b"\xff\xff\xff\xffTSource Engine Query\x00" + d[5:9], (h, p))
        d, _ = s.recvfrom(4096)
    f = d[6:].split(b"\x00")
    print("%s|%s" % (f[0].decode("utf8", "replace"), f[1].decode()))
except Exception:
    pass
finally:
    s.close()
PY
}

echo "=============================================="
echo " LahtiAG CS2 pre-event verification"
echo " $(date '+%F %T')   public IP: ${PUBIP:-unknown}"
echo "=============================================="

echo
echo "## Host"
FREE=$(df -BG --output=avail /mnt/storage | tail -1 | tr -dc 0-9)
[ "${FREE:-0}" -ge 20 ] && ok "disk free on /mnt/storage: ${FREE}G" \
                        || bad "disk free on /mnt/storage: ${FREE}G (under 20G)"

echo
echo "## Router port forwards (static NAT rules)"
if [ -x /root/zlist2.py ] || [ -f /root/zlist2.py ]; then
  RULES=$(python3 /root/zlist2.py 2>/dev/null)
  for p in 27015 27016 27020 27021; do
    echo "$RULES" | grep -q " $p-" && ok "forward present for $p" || bad "no static forward for $p"
  done
else
  warn "zlist2.py not present; cannot check router forwards"
fi

for N in 1 2; do
  case $N in
    1) INST=LahtiAG01;  PORT=27015; TV=27020 ;;
    2) INST=LahtiAG201; PORT=27016; TV=27021 ;;
  esac
  DIR=/mnt/storage/amp-instances/$INST
  CSGO=$DIR/counter-strike2/730/game/csgo

  echo
  echo "## Server $N ($INST)"

  # Maps must exist before anything else: a veto that offers a map the server
  # does not have strands the match at the map change.
  MISSING=""
  for m in $POOL; do [ -f "$CSGO/maps/$m.vpk" ] || MISSING="$MISSING $m"; done
  [ -z "$MISSING" ] && ok "all Active Duty maps installed" \
                    || bad "missing maps:$MISSING"

  # gameinfo.gi must reference metamod exactly once. AMP re-adds the line on
  # every start, so it accumulates duplicates, and a CS2 update wipes it.
  MM=$(grep -c "addons/metamod" "$CSGO/gameinfo.gi" 2>/dev/null || echo 0)
  case "$MM" in
    1) ok "gameinfo.gi references metamod once" ;;
    0) bad "gameinfo.gi does NOT reference metamod - CSSharp will not load" ;;
    *) warn "gameinfo.gi references metamod $MM times (duplicated)" ;;
  esac

  [ -f "$CSGO/cfg/lahtiag_server.cfg" ] && ok "lahtiag_server.cfg present" \
    || bad "lahtiag_server.cfg missing (settings would be lost; server.cfg is a depot file)"

  su -l amp -c "ampinstmgr --StartInstance $INST" >/dev/null 2>&1
  for i in $(seq 1 40); do ss -lunp 2>/dev/null | grep -q ":$PORT" && break; sleep 5; done
  sleep 12

  ss -lunp 2>/dev/null | grep -q ":$PORT" && ok "game port $PORT listening" \
                                          || bad "game port $PORT NOT listening"
  ss -lunp 2>/dev/null | grep -q ":$TV" && ok "GOTV port $TV listening" \
                                        || bad "GOTV port $TV NOT listening (tv_enable must be on the command line)"

  LOG=$(ls -t $DIR/AMP_Logs/*.log 2>/dev/null | head -1)

  grep -q "VAC secure mode is activated" "$LOG" && ok "VAC secure / Steam login OK" \
    || bad "no VAC activation - check the GSLT (reason code 5005 = dead token)"
  grep -q "reason code 5005" "$LOG" && bad "Steam cert failure 5005 in log - GSLT is invalid"

  if grep -q "old SourceHook Metamod build" "$LOG"; then
    bad "Metamod too new for CounterStrikeSharp - CSSharp did NOT load (pin MetamodBuild)"
  else
    ok "no Metamod/SourceHook mismatch"
  fi

  PLUGINS=$(/usr/local/bin/cs2 $N "css_plugins list" 2>/dev/null)
  echo "$PLUGINS" | grep -qi "MatchZy"  && ok "MatchZy loaded: $(echo "$PLUGINS" | grep -oiE '"MatchZy" \([0-9.]+\)' | head -1)" \
                                        || bad "MatchZy NOT loaded"
  echo "$PLUGINS" | grep -qi "Branding" && ok "branding plugin loaded" \
                                        || warn "branding plugin not loaded"

  # sv_minrate is REPLICATED: a floor the server forces on every client, GOTV
  # spectators included. We once set it to 786432 to "use LAN rates", which
  # held every viewer who could not sustain 6.3 Mbit/s at that rate until they
  # desynced and were dropped. A high CEILING (sv_maxrate 0) is the way to let
  # good connections run fast; a high floor only breaks weak ones.
  MINRATE=$(/usr/local/bin/cs2 $N "sv_minrate" 2>/dev/null | grep -oE '[0-9]+' | head -1)
  if [ -n "$MINRATE" ] && [ "$MINRATE" -le 98304 ]; then
    ok "sv_minrate $MINRATE (engine default or lower)"
  else
    bad "sv_minrate is ${MINRATE:-unknown} - a floor above 98304 disconnects GOTV viewers and players on slower links"
  fi

  MAXRATE=$(/usr/local/bin/cs2 $N "sv_maxrate" 2>/dev/null | grep -oE '[0-9]+' | head -1)
  [ "${MAXRATE:-1}" = "0" ] && ok "sv_maxrate 0 (clients pick their own rate)" \
                            || warn "sv_maxrate is ${MAXRATE:-unknown}, not 0 (unlimited)"

  TAGS=$(/usr/local/bin/cs2 $N "sv_tags" 2>/dev/null | tr -d '\n')
  echo "$TAGS" | grep -q "lahtiag" && ok "lahtiag_server.cfg applied (sv_tags)" \
                                   || bad "sv_tags missing - config not applied"

  for spec in "$PORT game" "$TV GOTV"; do
    set -- $spec
    R=$(a2s "$PUBIP" "$1")
    [ -n "$R" ] && ok "$2 reachable on public IP ${PUBIP}:$1 -> ${R%%|*}" \
                || bad "$2 NOT reachable on public IP ${PUBIP}:$1"
  done

  if [ "$KEEP" = "0" ]; then
    su -l amp -c "ampinstmgr --StopInstance $INST" >/dev/null 2>&1
    echo "  ....  stopped $INST"
  fi
done

echo
echo "=============================================="
echo " PASS: $PASS   WARN: $WARN   FAIL: $FAIL"
[ "$FAIL" -gt 0 ] && echo " NOT READY - fix the failures above."
[ "$FAIL" -eq 0 ] && echo " Ready."
echo "=============================================="
exit $([ "$FAIL" -gt 0 ] && echo 1 || echo 0)
