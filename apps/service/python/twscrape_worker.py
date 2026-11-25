"""Local twscrape adapter. Live operations use a guarded, direct transport."""

import asyncio
import json
import os
import re
import sqlite3
import sys
import time
from contextlib import aclosing, closing
from datetime import datetime
from email.utils import parsedate_to_datetime
from importlib.metadata import PackageNotFoundError, version


MAX_REQUEST = 160 * 1024
MAX_POSTS = 50
REQUEST_KEY = "twscrape:requests"
HOLD_KEY = "twscrape:hold"
HOUR = 3_600_000
DAY = 24 * HOUR


def package_status():
    try:
        installed = version("twscrape")
    except PackageNotFoundError:
        return {"status": "Package missing"}
    expected = os.path.join(os.path.dirname(__file__), "requirements.txt")
    with open(expected, encoding="utf-8") as requirements:
        if requirements.read().strip() != f"twscrape=={installed}":
            return {"status": "Package version mismatch"}

    os.environ["TWS_TELEMETRY"] = "0"
    from twscrape import API, AccountsPool

    methods = ("search", "search_raw", "tweet_details", "following", "user_by_login", "user_by_id")
    return {
        "status": "Ready for imports",
        "version": installed,
        "methods": [name for name in methods if callable(getattr(API, name, None))],
        "cookieSetup": callable(getattr(AccountsPool, "add_account_cookies", None)),
    }


def identifier(value):
    if type(value) is int:
        value = str(value)
    return value if isinstance(value, str) and re.fullmatch(r"[0-9]{1,25}", value) else None


def string(value, limit):
    return value[:limit] if isinstance(value, str) and value else None


def count(value):
    return value if type(value) is int and 0 <= value <= 2**53 - 1 else None


def media_metadata(media):
    if not isinstance(media, dict):
        return None
    result = []
    for key, kind in (("photos", "photo"), ("videos", "video"), ("animated", "gif")):
        values = media.get(key)
        if not isinstance(values, list):
            continue
        for item in values[:10]:
            if not isinstance(item, dict):
                continue
            url = string(item.get("url" if key == "photos" else "thumbnailUrl"), 512)
            if url and not url.startswith("https://pbs.twimg.com/"):
                url = None
            result.append({
                "kind": kind, "url": url, "width": count(item.get("width")),
                "height": count(item.get("height")), "alt": string(item.get("altText"), 1000),
                "durationMs": count(item.get("duration")),
            })
    return result[:10]


def normalize_post(post, now):
    if not isinstance(post, dict):
        raise ValueError
    post_id = identifier(post.get("id_str", post.get("id")))
    text = post.get("rawContent")
    if not post_id or not isinstance(text, str) or len(text) > 100_000:
        raise ValueError
    user = post.get("user")
    user = user if isinstance(user, dict) else {}
    handle = user.get("username")
    if not isinstance(handle, str) or not re.fullmatch(r"[A-Za-z0-9_]{1,15}", handle):
        handle = None
    created_at = None
    date = post.get("date")
    if date is not None:
        if not isinstance(date, str):
            raise ValueError
        timestamp = datetime.fromisoformat(date.replace("Z", "+00:00"))
        if timestamp.tzinfo is None:
            raise ValueError
        created_at = int(timestamp.timestamp() * 1000)
        if not 0 <= created_at <= now + 60_000:
            raise ValueError
    if post.get("retweetedTweetIdStr") or post.get("retweetedTweetId") or post.get("retweetedTweet"):
        kind = "repost"
    elif post.get("quotedTweetIdStr") or post.get("quotedTweetId") or post.get("isQuoteStatus"):
        kind = "quote"
    elif post.get("inReplyToTweetIdStr") or post.get("inReplyToTweetId"):
        kind = "reply"
    else:
        kind = "original"
    return {
        "namespace": "x", "id": post_id, "canonicalId": post_id, "text": text,
        "authorId": identifier(user.get("id_str", user.get("id"))),
        "handle": handle.lower() if handle else None,
        "displayName": string(user.get("displayname"), 100),
        "language": string(post.get("lang"), 16), "createdAt": created_at, "kind": kind,
        "metrics": {
            "likes": count(post.get("likeCount")), "reposts": count(post.get("retweetCount")),
            "replies": count(post.get("replyCount")), "views": count(post.get("viewCount")),
            "quotes": count(post.get("quoteCount")),
        },
        "observedAt": now, "observation": "manual:twscrape", "media": media_metadata(post.get("media")),
    }


def normalize_export(text, now):
    if not isinstance(text, str) or len(text.encode()) > 60 * 1024 or type(now) is not int or now < 0:
        raise ValueError
    lines = [line for line in text.removeprefix("\ufeff").split("\n") if line.strip()]
    if not 1 <= len(lines) <= MAX_POSTS:
        raise ValueError
    return [normalize_post(json.loads(line), now) for line in lines]


def reserve_request(db, now):
    """Debit an attempt before sending it. Return the earliest retry time at the cap."""
    with closing(sqlite3.connect(db, timeout=2)) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        blocked = connection.execute("SELECT value_json FROM settings WHERE key=?", (HOLD_KEY,)).fetchone()
        if blocked and (until := int(blocked[0])) > now:
            return until
        row = connection.execute("SELECT value_json FROM settings WHERE key=?", (REQUEST_KEY,)).fetchone()
        stamps = [stamp for stamp in (json.loads(row[0]) if row else []) if stamp + DAY > now]
        hourly = [stamp for stamp in stamps if stamp + HOUR > now]
        hold = max(hourly[-60] + HOUR if len(hourly) >= 60 else 0,
                   stamps[-600] + DAY if len(stamps) >= 600 else 0)
        if hold:
            return hold
        stamps.append(now)
        stamps.sort()
        connection.execute("INSERT INTO settings(key,value_json) VALUES (?,?) "
                           "ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
                           (REQUEST_KEY, json.dumps(stamps)))
        return None


def remember_hold(db, until):
    with closing(sqlite3.connect(db, timeout=2)) as connection, connection:
        connection.execute("INSERT INTO settings(key,value_json) VALUES (?,?) "
                           "ON CONFLICT(key) DO UPDATE SET value_json=CAST(max(CAST(settings.value_json AS INTEGER), "
                           "CAST(excluded.value_json AS INTEGER)) AS TEXT)", (HOLD_KEY, str(until)))


def response_block(status, headers, now):
    if status == 429 or headers.get("x-rate-limit-remaining") == "0":
        retry = headers.get("retry-after", "")
        reset = headers.get("x-rate-limit-reset", "")
        retry_at = now + 15 * 60_000
        try:
            if retry.isascii() and retry.isdecimal() and len(retry) <= 10:
                retry_at = now + int(retry) * 1000
            elif retry:
                retry_at = int(parsedate_to_datetime(retry).timestamp() * 1000)
        except (ValueError, OverflowError, OSError):
            pass
        return 429, max(now + 60_000, retry_at, int(reset) * 1000 if reset.isascii() and reset.isdecimal() and len(reset) <= 12 else 0)
    location = headers.get("location", "")
    if headers.get("cf-mitigated") == "challenge" or "/account/access" in location or "/i/flow/verify" in location:
        return 428, None
    if status == 401 or "/i/flow/login" in location or location.endswith("/login"):
        return 401, None
    if status in (403, 451):
        return 403, None
    return None


async def live_request(request):
    if package_status()["status"] != "Ready for imports":
        return {"status": 503}
    import httpx
    from twscrape import API, Account, AccountsPool, AbortReqError, XClIdParseError, set_log_level
    from twscrape import http as transport_module

    os.environ["TWS_HTTP_BACKEND"] = "httpx"
    os.environ.pop("TWS_PROXY", None)
    set_log_level("CRITICAL")
    operation, db, credentials = request["operation"], request["db"], request["credentials"]
    if operation not in ("profile", "search", "lookup", "following") or not isinstance(db, str):
        raise ValueError
    handle, auth, csrf = credentials["handle"], credentials["authToken"], credentials["csrfToken"]
    if not re.fullmatch(r"[A-Za-z0-9_]{1,15}", handle) or not all(
        isinstance(value, str) and re.fullmatch(r"[!-~]{1,1024}", value) for value in (auth, csrf)
    ):
        return {"status": 401}
    account = Account(username=handle, password="_", email="", email_password="", user_agent="SmartMonitor/0.1",
                      active=True, cookies={"auth_token": auth, "ct0": csrf})
    lock = asyncio.Lock()
    blocked = None
    pages = 0

    class Stop(AbortReqError):
        pass

    def stop(status, retry=None):
        nonlocal blocked
        blocked = {"status": status, **({"retryAt": retry} if retry else {})}
        if status == 429 and retry:
            remember_hold(db, retry)
        raise Stop()

    class GuardedTransport(httpx.AsyncHTTPTransport):
        async def handle_async_request(self, outbound):
            nonlocal pages
            async with lock:
                if blocked:
                    raise Stop()
                url = outbound.url
                static = url.host == "abs.twimg.com" and url.path.endswith(".js")
                if url.scheme != "https" or url.port not in (None, 443) or (url.host != "x.com" and not static):
                    stop(403)
                if outbound.method != "GET" or url.path.startswith(("/i/flow/", "/account/access")):
                    stop(428)
                if static:
                    for name in ("cookie", "authorization", "x-csrf-token"):
                        outbound.headers.pop(name, None)
                search = operation == "search" and "/graphql/" in url.path
                if search and pages >= 2:
                    stop(206)
                now = int(time.time() * 1000)
                hold = reserve_request(db, now)
                if hold:
                    stop(429, hold)
                pages += int(search)
                try:
                    response = await super().handle_async_request(outbound)
                    try:
                        limited = response_block(response.status_code, response.headers, int(time.time() * 1000))
                        if limited:
                            stop(*limited)
                        if 300 <= response.status_code < 400 and not static:
                            stop(403)
                        if "/graphql/" in url.path and response.status_code >= 400:
                            stop(503)
                        await response.aread()
                        if "/graphql/" in url.path:
                            if "text/html" in response.headers.get("content-type", ""):
                                stop(428)
                            data = response.json()
                            codes = {error.get("code") for error in data.get("errors", []) if isinstance(error, dict)}
                            if codes & {32, 89, 215}:
                                stop(401)
                            if codes & {64, 63, 326}:
                                stop(403)
                            if 88 in codes:
                                stop(429, now + 15 * 60_000)
                        return response
                    finally:
                        await response.aclose()
                except httpx.TransportError:
                    stop(503)

    class PlainClient(transport_module.HttpxClient):
        def __init__(self, *, proxy=None, headers=None, seed=None):
            if proxy is not None:
                stop(403)
            self._httpx = httpx
            self._client = httpx.AsyncClient(headers=headers, trust_env=False, follow_redirects=False,
                                             transport=GuardedTransport(retries=0, trust_env=False), timeout=7)

    class SingleSession(AccountsPool):
        async def get_for_queue_or_wait(self, queue):
            if blocked or not account.active:
                raise Stop()
            return account

        async def unlock(self, *args):
            pass

        async def lock_until(self, username, queue, reset_at, req_count=0):
            stop(429, reset_at * 1000)

        async def mark_inactive(self, *args):
            account.active = False
            stop(401)

    transport_module.HttpxClient = PlainClient
    api = API(SingleSession(raise_when_no_account=True))
    now = int(time.time() * 1000)
    items = {}
    try:
        if operation == "profile":
            user = await api.user_by_login(handle)
            return {"status": 200, "id": str(user.id), "handle": user.username} if user else {"status": 401}
        if operation == "search":
            query = request["query"]
            if not isinstance(query, str) or not 1 <= len(query) <= 500:
                raise ValueError
            async with aclosing(api.search(query, limit=40)) as posts:
                async for post in posts:
                    items[post.id_str] = normalize_post(json.loads(post.json()), now)
        elif operation == "lookup":
            ids = request["ids"]
            if not isinstance(ids, list) or not 1 <= len(ids) <= 3 or not all(identifier(value) for value in ids):
                raise ValueError
            for post_id in ids:
                post = await api.tweet_details(int(post_id))
                if post:
                    items[post.id_str] = normalize_post(json.loads(post.json()), now)
        else:
            account_id = identifier(request["accountId"])
            if not account_id:
                raise ValueError
            async with aclosing(api.following(int(account_id), limit=100)) as following:
                return {"status": 200, "following": [str(user.id) async for user in following]}
    except Stop:
        if blocked and blocked["status"] != 206:
            return blocked
        if not blocked:
            return {"status": 403}
    except XClIdParseError as error:
        return blocked or {"status": 428 if "challenge" in str(error).casefold() else 503}
    except Exception:
        return blocked or {"status": 503}
    return {"status": 200, "items": list(items.values())}


def main():
    response = {"error": "Invalid request"}
    try:
        raw = sys.stdin.buffer.read(MAX_REQUEST + 1)
        if len(raw) > MAX_REQUEST:
            raise ValueError
        request = json.loads(raw)
        if request == {"action": "status"}:
            response = {"result": package_status()}
        elif isinstance(request, dict) and request.keys() == {"action", "text", "now"} and request["action"] == "normalize":
            response = {"result": normalize_export(request["text"], request["now"])}
        elif isinstance(request, dict) and request.get("action") == "live" and {"operation", "db", "credentials"} <= request.keys():
            response = {"result": asyncio.run(live_request(request))}
    except (ValueError, OverflowError, RecursionError, OSError):
        pass
    except Exception:
        response = {"error": "Worker unavailable"}
    print(json.dumps(response, ensure_ascii=True, allow_nan=False))


if __name__ == "__main__":
    main()
