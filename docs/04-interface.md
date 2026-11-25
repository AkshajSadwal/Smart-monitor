# UI/UX specification

## Dashboard and navigation

The first question on the dashboard is “What deserves my attention?” Give most of the width to ranked posts. Reserve a smaller panel for source health and last successful collection. A returning user should be able to open a post, explain its rank or pause monitoring from the first screen.

~~~text
Desktop
┌───────────────┬────────────────────────────────────────────────────┐
│ Smart Monitor │ Dashboard                  Simulated · Monitoring │
│ Overview      │                                                    │
│ Watchlists    │ Matching posts today    High priority    Watchlists│
│ Feed          ├──────────────────────────────────┬─────────────────┤
│ Notifications │ Priority posts                   │ Collector health│
│ Data sources  │ Author, time, post text          │ Last / next poll│
│ Settings      │ Score · strongest reason         │ Pause monitoring│
│               │                                  ├─────────────────┤
│               │ Recent matches                   │ Recent alerts   │
└───────────────┴──────────────────────────────────┴─────────────────┘
~~~

## Visual system

| Token | Specification |
| --- | --- |
| Shell | Near-black navy #0D121B, one restrained blue radial glow behind the overview. Content width up to 1440 px. Static backgrounds |
| Surface | Base #182231 at 92% opacity, 1 px #334356 border, 14 px radius. Use up to 12 px backdrop blur on the navigation and detail overlay only. Solid surfaces in high-contrast/fallback mode |
| Type | Locally bundled Inter or system sans fallback. Body 15–16 px, label 13–14 px, page title 28–32 px. Tabular numerals for scores, counts and timestamps |
| Color | Primary text #F1F5FA, secondary #BAC8D6, action #91C9FF, healthy #90D9B5, waiting #F1C478, error #FFA8AB. Pair every state color with an icon and text |
| Spacing | 4 px base grid, 16–24 px panel padding, 24 px between sections, at most two card elevations. Separate feed rows with dividers |
| Motion | 120–180 ms opacity and panel transitions. Honor OS or app reduced motion, disable animated blur and skeleton shimmer. A mascot is optional visual reinforcement |
| Access | Verify 4.5:1 body-text contrast on composited surfaces, 3:1 for UI boundaries and focus. Two-pixel visible focus ring, 44 px primary touch targets, logical heading and tab order |

Use a sidebar at widths ≥1100 px, compact navigation and stacked diagnostics at 700–1099 px, and a single column with a labelled menu below 700 px. Keep source and pause state visible on mobile. Use a drawer for desktop detail and a full-screen view on narrow screens. At 320 px and 200% zoom, stack actions and wrap long keywords and handles. Count dashboard metrics over the selected source and local day; count distinct posts, and derive high priority from the relevant list's immediate threshold.

## Screen and interaction contract

| Screen | Hierarchy and primary action | Other states |
| --- | --- | --- |
| Onboarding | Create a watchlist with preview, then start monitoring with Simulated or a configured source. Offer a seeded software-release example | Explain when automatic collection is unavailable. Label simulation separately |
| Dashboard | Status and pause/resume, today’s counts, high-priority feed, recent matches, source health and recent notifications | New installation offers Create watchlist. No recent matches shows last successful check. Source error names the cause and next action |
| Watchlists | List name, terms summary, enabled control, matching count and thresholds. Edit in a full form with inclusion chips, match mode, exclusions, author/language filters, favorites, important terms, minimum engagement, thresholds and cooldown | Save validates inline. Preview runs the actual matcher on a typed sample or synthetic fixture. Warn on unsaved changes and confirm delete with the list name |
| Feed | Search, source/list, post kind, priority and sort. Each row shows author, creation time, excerpt, score, one reason and matched lists. Detail presents the original text, available counters, source and collection time, full reasons, feedback and Open on X | New arrivals accumulate behind “Show N new posts” while the user is reading. Preserve filters and scroll on detail close. A simulated post opens local detail only |
| Notifications | All/unread tabs, age, priority, source, reason, delivery status and Open original. Opening marks read. Mark all read applies to the current source | Show disabled/denied OS notifications with a test action. Distinguish delayed popularity from a delayed OS delivery. Purged content gets an unavailable state |
| Data sources | Local X Account, sharing, JSON import and a distinct Simulated test panel | Separate browser sign-in and collection availability. Display safe status, timestamps and post counts |
| Settings | Monitoring interval and pause, notification thresholds/defaults, cooldown, daily cap, quiet time zone, score weights, author preferences, retention, privacy, reduce motion and startup | Explain when changes affect future decisions. Browser MVP identifies startup management as a packaged-desktop capability. Data erasure shows the local profile and asks for confirmation |

**Post detail example, simulated.** “85 · Immediate” appears beside “Matched ‘release candidate’, favorite author.” Expanding Why this score shows relevance 1.00 × 35, popularity 0.50 × 20 and favorite author 1.00 × 10. The available weights total 65. Unknown follows and velocity appear under Unavailable and are excluded from the denominator. A second tab or disclosure shows the notification rule and decision time. Useful, Not relevant, Favorite post and Mute author are named controls with selected states and undo paths.

Use semantic links for navigation and buttons for actions. Label icon-only controls. Trap focus inside confirmation dialogs, restore it on close and announce save errors and source transitions. Keep the feed out of an assertive live region. On a lost SSE connection, preserve loaded content, display its age and reconnect; when REST is also unavailable, show service startup instructions. Notifications and status messages must remain intelligible with the mascot hidden.

## Displaying live X content

Use an original, distinctly simulated card design for fixtures. For actual X content, separate the local score and controls from the attributed post. Request the fields required for display, including URL entities. Render the unmodified text, linked author identity and avatar, linked timestamp, entities, source mark and original permalink according to X's current display requirements. Preserve long-form text and edit metadata when available. If required fields, media treatment or freshness cannot be satisfied, show the monitor's own match summary and Open on X without reproducing the post body. Native alerts default to a local reason and link. Validate the live rendering separately from the simulated prototype. [X post display requirements](https://docs.x.com/developer-terms/display-requirements)

## Mascot implementation manifest

**Inspected source root on this machine:** `A:\word survival\frontend`. The character is a white, asymmetric velvet pebble with a seeded fur coat, dark reflective eyes and an animated mouth. The mesh, fur distribution and texture are generated in JavaScript. Its small portrait is captured from the scene at runtime. No model file, sprite sheet or downloaded texture is needed.

| Source relative to frontend | Destination under apps/web | What to carry |
| --- | --- | --- |
| lib/mascot-model.js | components/mascot/model.ts | Geometry, seeded sampling, eye sockets, generated velvet texture, shader hooks, scene model and pose application. Full/low detail counts 5,000/1,800 |
| lib/mascot-controller.js | components/mascot/controller.ts | seededRandom, state table/aliases, characterState and createCharacterController with sampling and reactions. Omit aiCharacterMode, which maps game round data |
| lib/mascot-portrait.js | components/mascot/portrait.ts | Client-memory portrait publication/subscription and server snapshot |
| components/robot-scene.js | components/mascot/scene.tsx | Client-only renderer, camera, lighting, one-time 180×144 portrait, adaptive resolution, resize/visibility observers, cue handling and disposal |
| components/robot.js | components/mascot/mascot.tsx | Dynamic client import, error boundary, portrait/CSS fallback, intersection observation and stage container. Give the wrapper a monitor-state interface |
| hooks/use-presentation-clock.js | components/mascot/use-reduced-motion.ts | Extract the reduced-motion media query, subscription and useReducedMotion only |
| app/presentation.css | components/mascot/mascot.module.css | Stage, surface, canvas, shadow, avatar/body, portrait, expression and fallback selectors, avatar-float keyframes and reduced-motion overrides. Translate selector names together with JSX |

Keep React, React DOM and Next as frontend dependencies. The source declares three ^0.183.0 and the inspected installation resolves **0.183.2**. Pin that rendering baseline for visual comparison, add matching Three.js type definitions if needed, then validate any upgrade separately. The fur shader uses Three.js shader chunks. A successful TypeScript compile alone cannot prove its appearance. The room clock, round presentation, announcements, roster, authentication, sockets and game CSS are outside the dependency closure.

Map onboarding to GREETING, healthy collection to IDLE, a manual connection test to THINKING, first successful setup to CELEBRATING and disconnected to SAD with a textual explanation beside it. Use CURIOUS for the first empty watchlist state. Render one animated instance in view at most. Use the shared portrait for smaller appearances, omit it from dense feed rows and keep the source's hidden-tab, offscreen and low-detail behavior. With reduced motion, freeze the pose and disable fallback CSS animation. With WebGL unavailable before the portrait exists, show the CSS pebble. The service must never instantiate a renderer.

**Visual acceptance.** Compare original and port side by side at the same viewport, neutral camera and seeded idle pose. Inspect the silhouette, coat density, eye highlights, gaze, blink and celebration; exercise a change of cue, reduced motion, WebGL initialization failure and context loss. Scroll out of view, hide the tab, navigate away and back. Check animation frames and disposal with browser performance tools. Verify all integration changes reside in the new project.
