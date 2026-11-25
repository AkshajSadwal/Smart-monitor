# Local collection and imports

**Local X Account** uses an isolated desktop X window for manual sign-in. Remembered sessions and confirmed handles stay on the device. **Simulated** provides test posts and engagement changes for exercising watchlists and alerts.

X's documented search requires developer API authentication. X prohibits scripting its website, and no approved interface that accepts the browser session has been configured. Browser-cookie import, automated search, pagination, following, and liked-author retrieval are unavailable. The twscrape source separates account handling, pagination, parsing and storage. Its website GraphQL operations do not establish permission for Smart Monitor to use them. [X Automation Rules](https://help.x.com/en/rules-and-policies/x-automation) · [X Search API](https://docs.x.com/x-api/posts/search-recent-posts) · [twscrape source](https://github.com/vladkens/twscrape/blob/main/twscrape/api.py)

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
