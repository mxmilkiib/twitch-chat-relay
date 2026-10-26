#!/usr/bin/env python3
# replays sample log lines through mkstats.py in a tmpdir and checks the
# session, live, bounce, people and feed numbers. run: python3 test_mkstats.py
import gzip, json, os, subprocess, sys, tempfile, unittest
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
NOW = datetime(2026, 10, 26, 12, 0, 0, tzinfo=timezone.utc)


def line(mins_ago, id, via="hasanabi.neocities.org", bye="-", me="-", ch="hasanabi", vis="v", au="-",
         ev="tick", n=1, err=0, vid="-"):
    ts = (NOW - timedelta(minutes=mins_ago)).isoformat(timespec="seconds")
    return f"{ts} {id} {via} {bye} {me} {ch} {vis} {au} {ev} {n} {err} {vid}\n"


def run(main, rotated=(), extra=()):
    d = tempfile.mkdtemp()
    log = os.path.join(d, "use.txt")
    for name, content in [("use.txt", main), *rotated, *extra]:
        with (gzip.open if name.endswith(".gz") else open)(os.path.join(d, name), "wt") as f:
            f.write("".join(content))
    env = dict(os.environ, USE_LOG=log, USE_OUT=os.path.join(d, "stats.json"),
               USE_FEED=os.path.join(d, "beats.txt"), USE_NOW=str(NOW.timestamp()))
    subprocess.run([sys.executable, os.path.join(HERE, "mkstats.py")], env=env, check=True)
    with open(env["USE_OUT"]) as o, open(env["USE_FEED"]) as f:
        return json.load(o), f.read()


class Stats(unittest.TestCase):
    def test_live_session_and_median(self):
        s, _ = run([line(3, "aaaa1", ev="load"), line(2, "aaaa1"), line(1, "aaaa1")])
        self.assertEqual((s["live"], s["sessions"], s["beats"]), (1, 1, 3))
        self.assertEqual(s["last_beat"], int((NOW - timedelta(minutes=1)).timestamp()))

    def test_gap_splits_and_grace_ends_live(self):
        s, _ = run([line(30, "aaaa1", ev="load"), line(29, "aaaa1"), line(10, "aaaa1")])
        self.assertEqual((s["sessions"], s["live"]), (2, 0))

    def test_bye_ends_live_at_once(self):
        s, _ = run([line(2, "aaaa1", ev="load"), line(1, "aaaa1", bye="bye", ev="bye")])
        self.assertEqual(s["live"], 0)

    def test_bounce_counts_beats_per_session(self):
        s, _ = run([line(20, "aaaa1", ev="load"), line(19, "aaaa1"), line(18, "aaaa1"),
                    line(2, "aaaa1"), line(1, "aaaa1"), line(1, "bbbb2", ev="load")])
        self.assertEqual(s["sessions"], 3)
        self.assertEqual(s["bounce_pct"], 67)

    def test_median_ignores_single_beat_sessions(self):
        s, _ = run([line(40, "bbbb2", ev="load"),
                    line(20, "aaaa1", ev="load"), line(19, "aaaa1"), line(18, "aaaa1")])
        self.assertEqual(s["median_session_s"], 2 * 60 + 180)

    def test_unvalidated_beats_are_skipped(self):
        bad = [f"{(NOW - timedelta(minutes=1)).isoformat(timespec='seconds')} aaaa1 hasanabi.neocities.org - - - v -\n",
               line(1, "bbbb2", via="localhost"), line(1, "cccc3", via="127.0.0.1"),
               line(1, "dddd4", ev="bogus")]
        s, feed = run(bad + [line(1, "eeee5", ev="load")])
        self.assertEqual((s["beats"], s["uniques"]["all"]), (1, 1))
        self.assertEqual(feed.count("\n"), 1)

    def test_people_fold_tabs_by_me_then_vid(self):
        s, _ = run([line(1, "tab01", vid="vvvv1"), line(1, "tab02", vid="vvvv1"),
                    line(1, "tab03", me="malkiii", vid="vvvv2"), line(1, "tab04", me="malkiii", vid="vvvv3"),
                    line(1, "tab05")])
        self.assertEqual(s["uniques"]["all"], 5)
        self.assertEqual(s["people"]["all"], 3)

    def test_feed_has_no_private_fields(self):
        _, feed = run([line(1, "aaaa1", vid="secretvid", n=7, err=2, ev="tick")])
        self.assertNotIn("secretvid", feed)
        self.assertEqual(len(feed.split()), 8)

    def test_feed_keeps_only_30_days(self):
        _, feed = run([line(31 * 24 * 60, "oldie", ev="load"), line(1, "newbie", ev="load")])
        self.assertIn("newbie", feed)
        self.assertNotIn("oldie", feed)

    def test_rotated_logs_are_read_and_prefixed_archives_are_not(self):
        s, _ = run([line(1, "aaaa1")],
                   rotated=[("use.txt.1", [line(5, "bbbb2", ev="load")]),
                            ("use.txt.2.gz", [line(9, "cccc3", ev="load")])],
                   extra=[("use.txt.pre-gate_x", [line(7, "dddd4", ev="load")])])
        self.assertEqual(s["uniques"]["all"], 3)

    def test_empty_log(self):
        s, feed = run([])
        self.assertEqual((s["live"], s["beats"], s["last_beat"], feed), (0, 0, 0, ""))


class Health(unittest.TestCase):
    def setUp(self):
        sys.path.insert(0, HERE)
        import usehealth
        self.check = usehealth.check

    def test_healthy(self):
        now = NOW.timestamp()
        self.assertEqual(self.check({"now": now - 60, "last_beat": now - 600}, now), [])

    def test_stale_stats_and_quiet_log(self):
        now = NOW.timestamp()
        got = self.check({"now": now - 900, "last_beat": now - 5 * 3600}, now)
        self.assertEqual(len(got), 2)

    def test_empty_and_missing(self):
        now = NOW.timestamp()
        self.assertEqual(self.check({"now": now, "last_beat": 0}, now), ["no beats in the log"])
        self.assertEqual(self.check(None, now), ["stats.json missing or unreadable"])


if __name__ == "__main__":
    unittest.main()
