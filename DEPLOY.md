# Deploying to Hostinger (VPS)

This app ships as a Docker image (`Dockerfile`) run via `docker-compose.yml`, with
migrations applied automatically by `docker-entrypoint.sh` on container start.
Auto-deploy on push to `dev` is wired in `.github/workflows/deploy.yml`.

Two paths are documented below:
- **A. One-time manual deploy** — do this first, to prove the VPS/DB/secrets are correct.
- **B. Enable CI/CD** — after A works, wire GitHub Actions so every push to `dev` deploys itself.

Repo: `https://github.com/Startsmartz-Technologies-Projects/ze-erp-nestjs-backend`

---

## A. One-time manual deploy

Run these **on the VPS**, over SSH, as a non-root user with Docker permissions
(`sudo usermod -aG docker $USER`, then re-login, if `docker` needs `sudo` today).

### A1. Pick a deploy path and clone the repo

```bash
mkdir -p ~/apps
cd ~/apps

# Generate a deploy-only SSH keypair — used ONLY for this VPS to pull from GitHub.
# This is separate from any key used to SSH *into* the VPS.
ssh-keygen -t ed25519 -f ~/.ssh/gh_deploy -N "" -C "hostinger-vps-deploy-key"
cat ~/.ssh/gh_deploy.pub
```

Copy that public key into **GitHub → repo → Settings → Deploy keys → Add deploy key**
(leave "Allow write access" **unchecked** — read-only is enough).

Then point git at that key for this host only:

```bash
cat >> ~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/gh_deploy
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config

git clone -b dev git@github.com:Startsmartz-Technologies-Projects/ze-erp-nestjs-backend.git
cd ze-erp-nestjs-backend
```

### A2. Create the production `.env`

`.env` is gitignored on purpose — it holds real secrets and is never pulled from git.
Create it once, directly on the VPS:

```bash
cp .env.example .env
chmod 600 .env        # secrets file — owner read/write only
nano .env              # or vim/vi
```

Fill in real values (see `src/config/env.schema.ts` for what's required vs optional):

| Variable | Notes |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | `3000` (internal container port — compose maps `7001:3000`) |
| `LOG_LEVEL` | `info` |
| `DB_HOST` / `DB_PORT` / `DB_USERNAME` / `DB_PASSWORD` / `DB_NAME` | your Postgres — see A3 |
| `DB_SSL` | `true` if your Postgres requires TLS (most managed Postgres does) |
| `DB_POOL_MAX` | `20` (pool ceiling, ADR-0002 §2.3) |
| `JWT_SECRET` | **generate a real one** — `openssl rand -base64 48` — never reuse the placeholder |
| `JWT_ACCESS_TTL` / `JWT_REFRESH_TTL` | `900s` / `7d` (defaults are fine) |
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | optional — only needed for profile-avatar upload |

### A3. Point `DB_HOST` at a real Postgres 15+

`docker-compose.yml` runs the app only — it does **not** bundle Postgres, so pick one:

- **Hostinger managed PostgreSQL**, or any external Postgres reachable from the VPS
  → set `DB_HOST` to its hostname, `DB_SSL=true`.
- **Self-hosted Postgres container on the same VPS** — if you don't have one yet:
  ```bash
  docker network create ze-erp-net
  docker run -d --name ze-erp-postgres --network ze-erp-net \
    --restart unless-stopped \
    -e POSTGRES_USER=ze_erp -e POSTGRES_PASSWORD='<strong-password>' -e POSTGRES_DB=ze_erp \
    -v ze-erp-pgdata:/var/lib/postgresql/data \
    postgres:15-alpine
  ```
  Then in `docker-compose.yml`, add the app service to that same network so it can
  reach Postgres by container name (`DB_HOST=ze-erp-postgres`):
  ```yaml
  services:
    ze-erp-backend:
      # ...existing config...
      networks:
        - ze-erp-net
  networks:
    ze-erp-net:
      external: true
  ```
  **Do not** publish Postgres's `5432` to the public interface — no `ports:` on the
  DB container. Only the app should reach it, over the internal Docker network.

### A4. Build and start

```bash
docker compose build
docker compose up -d
```

`docker-entrypoint.sh` runs `typeorm migration:run` before the server starts —
watch it happen:

```bash
docker compose logs -f ze-erp-backend
```

You should see `N migrations were found`, each one `executed successfully`, then
`ze-erp-nestjs-backend listening on http://localhost:3000/api`. `Ctrl+C` to stop tailing.

### A5. Verify

```bash
curl -s http://localhost:7001/health
# {"status":"ok","info":{"database":{"status":"up"}},...}
```

From outside the VPS, `7001` likely isn't open yet — see **Networking & TLS** below
before exposing it publicly.

---

## B. Enable CI/CD (auto-deploy on push to `dev`)

Once A works end-to-end, hand deploys off to `.github/workflows/deploy.yml`.

### B1. Generate a *second*, separate SSH keypair — for GitHub Actions to log into the VPS

Do this on your own machine (not the VPS):

```bash
ssh-keygen -t ed25519 -f ./gh_actions_deploy -N "" -C "github-actions-to-hostinger"
```

Append the **public** key to the VPS's authorized keys (as the deploy user from A):

```bash
ssh-copy-id -i ./gh_actions_deploy.pub deploy@<vps-ip>
# or manually: cat gh_actions_deploy.pub | ssh deploy@<vps-ip> "cat >> ~/.ssh/authorized_keys"
```

Keep the **private** key (`gh_actions_deploy`, no extension) — it goes into a GitHub secret next, then delete it locally.

### B2. Add GitHub Actions secrets

**Repo → Settings → Secrets and variables → Actions → New repository secret:**

| Secret | Value |
|---|---|
| `HOSTINGER_HOST` | VPS IP/hostname |
| `HOSTINGER_USERNAME` | the deploy user from A1 (e.g. `deploy`) |
| `HOSTINGER_SSH_KEY` | contents of `gh_actions_deploy` (the **private** key from B1) |
| `HOSTINGER_PORT` | SSH port, usually `22` |
| `HOSTINGER_DEPLOY_PATH` | absolute path from A1, e.g. `/home/deploy/apps/ze-erp-nestjs-backend` |

### B3. Trigger it

```bash
git checkout dev
git push origin dev
```

**Actions** tab → `Deploy to Hostinger` run: `test` job (typecheck/lint/`npm test`) must
pass before `deploy` runs. The deploy step SSHes in, `git fetch && git reset --hard
origin/dev`, then `docker compose build && up -d`.

If `test` fails, nothing touches the VPS — fix the code and push again.

---

## Everyday operations

**Redeploy manually** (bypassing CI, e.g. to test a hotfix before pushing):
```bash
cd ~/apps/ze-erp-nestjs-backend
git fetch origin dev && git reset --hard origin/dev
docker compose build && docker compose up -d
docker image prune -f
```

**Tail logs:**
```bash
docker compose logs -f --tail=200 ze-erp-backend
```

**Run a migration manually** (rare — the entrypoint already does this on every start):
```bash
docker compose exec ze-erp-backend npx typeorm migration:run -d dist/database/data-source.js
```

**Rollback** (deploy an older, known-good commit):
```bash
cd ~/apps/ze-erp-nestjs-backend
git fetch origin dev
git reset --hard <good-commit-sha>
docker compose build && docker compose up -d
```
Note: this does **not** revert database migrations. If the bad deploy shipped a
destructive migration, write and run a compensating migration — never edit or
delete an applied one (see `CLAUDE.md` — append-only ledger, same spirit applies
to schema history).

**Check container health:**
```bash
docker inspect --format='{{json .State.Health}}' ze-erp-backend | jq
```

---

## Networking & TLS (do this before going live)

The app listens on plain HTTP inside the container; `docker-compose.yml` maps it to
`7001` on the VPS. Don't expose `7001` directly to the internet as the public entry
point — put a reverse proxy in front for TLS:

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

Nginx server block (`/etc/nginx/sites-available/ze-erp`):
```nginx
server {
    listen 80;
    server_name api.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:7001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
```bash
sudo ln -s /etc/nginx/sites-available/ze-erp /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d api.yourdomain.com
```

Then lock the firewall down to only what's needed:
```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'   # 80 + 443
sudo ufw enable
sudo ufw status
```
`7001` and Postgres's `5432` should **not** appear in `ufw status` — they're only
reachable from `localhost` / the internal Docker network, never the public interface.

---

## Troubleshooting

- **Migrations fail on boot / container restarts in a loop** — check
  `docker compose logs ze-erp-backend`; it's almost always `DB_HOST`/`DB_SSL`/credentials
  in `.env`, or Postgres not reachable yet on first boot.
- **`Nest application successfully started` never appears** — a required env var is
  missing; `env.schema.ts` fails boot fast with the missing key named in the log.
- **GitHub Actions `deploy` step: `Permission denied (publickey)`** — the private key in
  `HOSTINGER_SSH_KEY` doesn't match a key in the VPS user's `~/.ssh/authorized_keys`
  (see B1/B2), or `HOSTINGER_USERNAME`/`HOSTINGER_PORT` is wrong.
- **VPS `git fetch` fails with `Permission denied (publickey)`** — the *other* key
  (A1's `gh_deploy`) isn't registered as a GitHub Deploy Key, or `~/.ssh/config`'s
  `IdentityFile` doesn't match.
- **`/health` returns 503** — `database.status: down`; Postgres is unreachable or down —
  check A3's network/credentials.
