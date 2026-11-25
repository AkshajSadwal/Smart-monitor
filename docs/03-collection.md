# Data collection feasibility

The session-based release has two production entry points and one test mode. [Setup and deployment](09-multi-source.md)

| Mode | Available now | External requirement |
| --- | --- | --- |
| Local X Account | Manual sign-in and browsing in an isolated desktop window. Session detection and disconnect. Voluntary sharing of selected posts. | Automated reading needs a specifically approved interface, its documented contract, and a verified account and search. |
| Hosted Monitoring | Authenticated simulation, approved topic aggregation, SSE and replay. | A separately administered authorized source and permission to distribute the chosen fields to recipients. |
| Simulated | Repeatable local posts, engagement snapshots, delayed alerts, ranked feed and history. | No external service or credentials. |

X's automation rules prohibit scripting the website. A browser sign-in establishes a website session within Electron, while collection needs separate permission. Undocumented GraphQL interfaces and browser-cookie import have no approved integration in this release. Email challenges and MFA are handled by the user on X. [X Automation Rules](https://help.x.com/en/rules-and-policies/x-automation)

The reference project's separation of session setup, operation scheduling, pagination and response parsing informed the module boundaries. Its multi-account rotation and private endpoint behaviors are outside this release. [twscrape](https://github.com/vladkens/twscrape)

Local session fixtures exercise a stored grant, rule delivery, cursor resumption, rate-limit deadlines, denied access and local ranking. An approved production provider would need to verify keyword and phrase search, hashtags, author restrictions, engagement lookup and account signals individually. Missing fields stay unknown. [X content policy and release gates](12-content-compliance.md)
