#!/usr/bin/env python3
# aggregates use.txt into stats.json for external consumers - same
# session model as the dashboard: one 3m value is both the split gap and the
# live grace, bye ends; published as session_s so the dashboard follows it.
# this is the one place beats are validated: the private raw log is parsed here,
# and the public beats.txt feed (30 days, no vid/ev/n/err) is written from the
# beats that pass, so the dashboard never reads raw or unvalidated lines.
# the beat format is specified in the repo README under "Presence beats"
import glob, gzip, json, re, os, time
from datetime import datetime, timezone

# paths and the clock take env overrides so the tests can run it in a tmpdir
LOG = os.environ.get("USE_LOG", "/var/log/nginx/use.txt")
OUT = os.environ.get("USE_OUT", "/var/www/orange.thingsandstuff.org/use/stats.json")
FEED = os.environ.get("USE_FEED", "/var/www/orange.thingsandstuff.org/use/beats.txt")
now = float(os.environ.get("USE_NOW", time.time()))
SESSION_S = 180
GAP = GRACE = SESSION_S
EVS = {"load", "tick", "vis", "me", "retry", "bye"}
FEED_DAYS = 30
beats, feed = [], []

# the live log plus logrotate's numbered copies (use.txt.1, use.txt.2.gz, ...);
# the use.txt.pre-gate_* archive is deliberately not matched
def lines():
    for f in [LOG] + sorted(glob.glob(glob.escape(LOG) + ".[0-9]*")):
        if not os.path.exists(f): continue
        with (gzip.open(f, "rt", errors="replace") if f.endswith(".gz") else open(f, errors="replace")) as fh:
            yield from fh

for line in lines():
    p = line.split()
    if len(p) < 2: continue
    if len(p) > 2 and re.fullmatch(r"localhost|127\.0\.0\.1", p[2], re.I): continue
    if len(p) < 9 or p[8] not in EVS: continue
    try: t = datetime.fromisoformat(p[0]).timestamp()
    except ValueError: continue
    feed.append((t, " ".join(p[:8])))
    beats.append((t, p[1], p[2] if len(p) > 2 and re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9.-]*", p[2]) else "",
                  len(p) > 3 and p[3] == "bye",
                  p[4] if len(p) > 4 and re.fullmatch(r"[a-zA-Z0-9]{1,12}", p[4]) else "",
                  p[5].split(",") if len(p) > 5 and re.fullmatch(r"[a-z0-9_]{2,25}(,[a-z0-9_]{2,25}){0,5}", p[5]) else [],
                  p[6] if len(p) > 6 and p[6] in "vh" else "",
                  len(p) > 7 and p[7] == "au",
                  p[11] if len(p) > 11 and re.fullmatch(r"[a-zA-Z0-9]{1,12}", p[11]) else ""))
beats.sort(key=lambda b: b[0])
feed.sort(key=lambda f: f[0])
by_id = {}
for b in beats: by_id.setdefault(b[1], []).append(b)
sess = []
for i, es in by_id.items():
    j = 0
    for k in range(1, len(es) + 1):
        if k == len(es) or es[k][0] - es[k-1][0] > GAP:
            seg = es[j:k]
            sess.append({"id": i, "s": seg[0][0], "e": seg[-1][0], "bye": seg[-1][3],
                         "sites": sorted({x[2] for x in seg if x[2]}),
                         "mes": sorted({x[4] for x in seg if x[4]}),
                         "chans": sorted({c for x in seg for c in x[5]}),
                         "vis": seg[-1][6], "au": seg[-1][7], "n": len(seg)})
            j = k
live = [x for x in sess if x["e"] + (0 if x["bye"] else GRACE) > now]
def uniq(ms, key): return len({key(b) for b in beats if b[0] > now - ms})
ids = {b[1] for b in beats}
ppl = lambda ms: uniq(ms, lambda b: b[4] or b[8] or b[1])
durs = sorted(x["e"] - x["s"] + (0 if x["bye"] else GRACE) for x in sess if x not in live and x["n"] > 1)
evs = sorted(e for x in sess for e in [(x["s"], 1), (x["e"] + (0 if x["bye"] else GRACE), -1)])
pk = cur = pk_at = 0
for t, d in evs:
    cur += d
    if cur > pk: pk, pk_at = cur, t
day_ids = {}
for b in beats: day_ids.setdefault(int(b[0] // 86400), set()).add(b[1])
busy_d, busy_n = (max(day_ids.items(), key=lambda kv: len(kv[1])) if day_ids else (0, 0))
sites = {}
for st in sorted({b[2] or "untagged" for b in beats}):
    bs = [b for b in beats if (b[2] or "untagged") == st]
    sites[st] = {"beats": len(bs), "ids": len({b[1] for b in bs}),
                 "live": sum(1 for x in live if st in (x["sites"] or ["untagged"]))}
chans = {}
for x in live:
    for c in x["chans"]: chans[c] = chans.get(c, 0) + 1
out = {"now": int(now), "session_s": SESSION_S, "last_beat": int(beats[-1][0]) if beats else 0,
       "live": len(live),
       "live_hidden": sum(1 for x in live if x["vis"] == "h"),
       "live_authed": sum(1 for x in live if x["au"]),
       "uniques": {"m15": uniq(900, lambda b: b[1]), "h1": uniq(3600, lambda b: b[1]),
                    "h24": uniq(86400, lambda b: b[1]), "all": len(ids)},
       "people": {"h24": ppl(86400), "all": ppl(float("inf"))},
       "beats": len(beats), "sessions": len(sess),
       "median_session_s": int(durs[len(durs) // 2]) if durs else 0,
       "bounce_pct": round(100 * sum(1 for x in sess if x["n"] <= 2) / max(1, len(sess))),
       "bye_pct": round(100 * sum(1 for x in sess if x["bye"] and x["e"] <= now - GAP) / max(1, len(sess) - len(live))),
       "peak_ever": {"n": pk, "at": int(pk_at)},
       "busiest_day": {"day": int(busy_d) * 86400, "uniques": len(busy_n) if busy_n else 0},
       "sites": sites, "channels_live": chans}
tmp = OUT + ".tmp"
open(tmp, "w").write(json.dumps(out))
os.rename(tmp, OUT)
ftmp = FEED + ".tmp"
open(ftmp, "w").write("".join(l + "\n" for t, l in feed if t > now - FEED_DAYS * 86400))
os.rename(ftmp, FEED)
