import asyncio
import json
import runpy
import sqlite3
import sys
import unittest
from contextlib import closing
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import httpx
import twscrape
from twscrape import http as tws_http


worker = Path(__file__).resolve().parent.parent / "apps/service/python/twscrape_worker.py"
scope = runpy.run_path(str(worker))
HOUR, DAY = scope["HOUR"], scope["DAY"]


class PolicyTest(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory(dir=sys.argv[1])
        self.addCleanup(self.temp.cleanup)
        self.db = str(Path(self.temp.name) / 'test.sqlite')
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute("CREATE TABLE settings(key TEXT PRIMARY KEY,value_json TEXT NOT NULL)")

    def test_rolling_caps_across_connections(self):
        reserve = scope["reserve_request"]
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute("INSERT INTO settings VALUES (?,?)", (scope["REQUEST_KEY"], json.dumps(list(range(59)))))
        self.assertIsNone(reserve(self.db, 59))
        self.assertEqual(reserve(self.db, 60), HOUR)
        with closing(sqlite3.connect(self.db)) as db, db:
            stamps = [hour * HOUR + attempt for hour in range(10) for attempt in range(60)]
            db.execute("UPDATE settings SET value_json=?", (json.dumps(stamps),))
        self.assertEqual(reserve(self.db, 14 * HOUR), DAY)
        self.assertIsNone(reserve(self.db, DAY))

    def test_shared_transport_serializes_and_limits_search_pages(self):
        calls = []
        active = 0

        async def upstream(_self, request):
            nonlocal active
            self.assertEqual(active, 0)
            active += 1
            try:
                calls.append(str(request.url))
                if request.url.host == "abs.twimg.com":
                    self.assertNotIn("cookie", request.headers)
                    self.assertNotIn("authorization", request.headers)
                await asyncio.sleep(.001)
                return httpx.Response(200, json={"data": {"fixture": True}})
            finally:
                active -= 1

        class Post:
            def __init__(self, number):
                self.id_str = str(number)

            def json(self):
                return json.dumps({"id_str": self.id_str, "rawContent": "sqlite"})

        async def search(_api, _query, limit):
            self.assertEqual(limit, 40)
            async with tws_http.make_client(backend="httpx", headers={"authorization": "fixture"}) as client:
                await asyncio.gather(*(client.get(f"https://abs.twimg.com/fixture-{i}.js") for i in range(2)))
                for page in range(3):
                    await client.get("https://x.com/i/api/graphql/fixture/SearchTimeline")
                    yield Post(page + 1)

        request = self.request("search", query="sqlite")
        with patch.object(httpx.AsyncHTTPTransport, "handle_async_request", upstream), patch.object(twscrape.API, "search", search):
            reply = asyncio.run(scope["live_request"](request))
        self.assertEqual(reply["status"], 200)
        self.assertEqual([p["id"] for p in reply["items"]], ["1", "2"])
        self.assertEqual(len(calls), 4)

    def test_rate_limit_is_persisted_and_redirects_are_never_followed(self):
        calls = []

        async def upstream(_self, request):
            calls.append(str(request.url))
            return httpx.Response(429, headers={"retry-after": "900"})

        async def profile(_api, handle):
            self.assertEqual(handle, "fixture")
            async with tws_http.make_client(backend="httpx") as client:
                await client.get("https://x.com/")

        request = self.request("profile")
        with patch.object(httpx.AsyncHTTPTransport, "handle_async_request", upstream), patch.object(twscrape.API, "user_by_login", profile):
            limited = asyncio.run(scope["live_request"](request))
            held = asyncio.run(scope["live_request"](request))
        self.assertEqual(limited["status"], 429)
        self.assertEqual(limited, held)
        self.assertEqual(calls, ["https://x.com/"])
        self.assertEqual(scope["response_block"](302, {"location": "/account/access"}, 0), (428, None))
        self.assertEqual(scope["response_block"](302, {"location": "/i/flow/login"}, 0), (401, None))

    def request(self, operation, **kwargs):
        return {"operation": operation, "db": self.db,
                "credentials": {"handle": "fixture", "authToken": "fixture", "csrfToken": "fixture"}, **kwargs}


if __name__ == "__main__":
    unittest.main(argv=sys.argv[:1])
