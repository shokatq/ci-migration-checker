# Test fixtures

Real GitHub Actions workflows from popular open-source projects, copied unmodified on 2026-10-28 so the
mapper is tested against what people actually write, not toy examples. Each file keeps its project's license.

| File | Source | License |
| --- | --- | --- |
| `express-ci.yml` | [expressjs/express](https://github.com/expressjs/express/blob/master/.github/workflows/ci.yml) | MIT |
| `flask-tests.yml` | [pallets/flask](https://github.com/pallets/flask/blob/main/.github/workflows/tests.yaml) | BSD-3-Clause |
| `gin.yml` | [gin-gonic/gin](https://github.com/gin-gonic/gin/blob/master/.github/workflows/gin.yml) | MIT |
| `vite-ci.yml` | [vitejs/vite](https://github.com/vitejs/vite/blob/main/.github/workflows/ci.yml) | MIT |
| `fastapi-test.yml` | [fastapi/fastapi](https://github.com/fastapi/fastapi/blob/master/.github/workflows/test.yml) | MIT |

`expected/` holds the generated `.gitlab-ci.yml` for each fixture. Tests compare against these files, so a
change in output shows up as a reviewable diff. After an intentional change, run `npx vitest run -u` and
review the diff before committing.
