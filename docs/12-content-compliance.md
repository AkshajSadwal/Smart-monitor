# Local X data and privacy

- The isolated X window keeps session credentials in its browser partition. Smart Monitor stores a confirmed handle and session fingerprint in an OS-encrypted desktop record. The local UI receives status and the handle.
- Manual sharing and JSON imports save only user-selected posts in the local profile. They run through local watchlist matching and ranking. Unavailable account signals stay unknown. Manual input does not generate alerts.
- X's published rules prohibit scripting its website. Automated reads require a separately authorized interface. [X Automation Rules](https://help.x.com/en/rules-and-policies/x-automation)
- Optional official widgets load on demand after consent and may contact X. Original post links remain available. [X Display requirements](https://docs.x.com/developer-terms/display-requirements)
- Use `npm run monitor -- purge-x POST_ID --confirm` for content that must be removed. The profile removes cached post data and preserves a minimal suppression marker. Handle any private backup copies separately. [X Developer Policy](https://docs.x.com/developer-terms/policy)
