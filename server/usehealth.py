#!/usr/bin/env python3
# cron health check for the use/ system: warns to syslog (user.warning, tag
# use-health) when stats.json stops refreshing or no beat has landed for hours.
# exit 1 on a problem so a cron wrapper or monitor can act on it
import json, os, subprocess, sys, time

STATS = os.environ.get("USE_OUT", "/var/www/orange.thingsandstuff.org/use/stats.json")
STALE_S = 300         # mkstats runs every minute; five missed runs is a fault
QUIET_S = 3 * 3600    # no beats for this long means the pipeline or the gate broke


def check(stats, now):
    problems = []
    if not stats: return ["stats.json missing or unreadable"]
    if now - stats.get("now", 0) > STALE_S:
        problems.append(f"stats.json is {int(now - stats.get('now', 0))}s old")
    last = stats.get("last_beat", 0)
    if not last: problems.append("no beats in the log")
    elif now - last > QUIET_S:
        problems.append(f"no beat for {int((now - last) / 3600)}h")
    return problems


if __name__ == "__main__":
    try:
        with open(STATS) as f: stats = json.load(f)
    except (OSError, ValueError): stats = None
    problems = check(stats, time.time())
    for p in problems:
        subprocess.run(["logger", "-t", "use-health", "-p", "user.warning", p])
        print(p, file=sys.stderr)
    sys.exit(1 if problems else 0)
