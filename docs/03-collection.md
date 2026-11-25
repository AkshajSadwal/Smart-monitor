# Local collection and imports

**Local X Account** uses an isolated desktop X window for manual sign-in. Remembered sessions and confirmed handles stay on the device. **Simulated** provides test posts and engagement changes for exercising watchlists and alerts.

Authorized desktop deployments can opt in to the [twscrape driver](../README.md#authorized-live-collection-on-windows). It uses one confirmed Electron account. The worker sends requests directly to X, maintains no separate account database, and stops on challenges, restrictions, or expired sessions.

Search defaults to every five minutes with a two-minute minimum. Each search uses up to two pages or 40 posts. A rolling budget allows 60 requests per hour and 600 per day, including worker setup requests. The budget and upstream holds persist in the local profile. Only one request is in flight. Engagement rechecks run at most every 15 minutes and prioritize posts with pending rechecks. Following refresh runs every 24 hours and stores up to 100 following records. Liked-post signals remain unavailable.

## Manual imports

Open **Data sources → Local X Account → Import posts**, or paste one permalink and excerpt with **Share selected X post**. The JSON importer accepts an array of up to 50 posts within 60 KB. Each needs `url` and `text`. Optional fields are `author`, `createdAt` with an ISO 8601 offset, `language`, and a `metrics` object with nonnegative integer `likes`, `reposts`, `replies`, and `views`. Omit unknown fields.

~~~json
[
  {
    "url": "https://x.com/i/web/status/1234",
    "text": "SQLite release candidate",
    "author": "example",
    "language": "en",
    "metrics": { "likes": 10 }
  }
]
~~~

These are user-provided records. Use the JSON format above for import. Text, handles and counts come from the selected data. Enable your watchlists before importing, then select **View manual posts**. Reimport a post to apply current watchlists or record a changed metrics snapshot. Identical observations remain deduplicated. Manual posts never schedule alerts or automated metric refreshes. Following and liked-author signals are unknown for manual posts. Local favorites, mutes and feedback still apply.
