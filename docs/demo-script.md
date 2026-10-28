# Demo recording plan (60–90 seconds)

Screen recording plus voice-over, at 1280×800 or larger, with the browser zoomed to 110% so text is readable on a phone.
Free tools: OBS Studio, or Windows' built-in Snipping Tool screen recorder (Win+Shift+R).
Before you record: run `npm run dev` (or open the deployed URL), sign the browser in nowhere, and load one
repo once so the GitHub API responses are warm. The CI-minutes card needs API calls that count against
GitHub's 60/hour limit, so add a token under "Private repo or rate-limited?" if you record several takes.

Talking points are notes, not a script. Say them in your own words.

| Time | On screen | Say (in your words) |
| --- | --- | --- |
| 0:00–0:10 | The empty home page | The hook from your article: switching CI is the hardest part of leaving GitHub, so this tool answers "how much of our CI would we have to rewrite?" |
| 0:10–0:20 | Click the `gin-gonic/gin` example, results appear | Paste any public repo. It reads every workflow through GitHub's API, all in the browser. |
| 0:20–0:35 | Score card and CI-minutes card | Readiness score, plus what the repo actually burns: about 3,500 CI minutes a month, almost 9× GitLab Free's 400. Tie back to the free-tier point in the article. |
| 0:35–0:55 | Open the `test` job; point at the matrix and the macOS finding | Every item is marked clean, manual or no equivalent, with the reason. Here the macOS legs need Premium runners, and it says so rather than pretending. |
| 0:55–1:15 | Scroll to the generated `.gitlab-ci.yml`; point at an amber TODO; click Download | You get a real starting file. The TODOs sit exactly where a person needs to decide something. |
| 1:15–1:30 | Back to top; show the GitHub repo URL | Open source, tested on 17 real projects; link in the comments. Ask: which repo should I run next? |

After recording, trim the dead air and add captions. Most LinkedIn video is watched muted.
