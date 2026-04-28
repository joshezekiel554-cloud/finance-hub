# VPS first-time setup for `finance-hub`

This is a checklist for week 9 deployment, mirroring the `orders.feldart.com`
setup pattern but installing alongside it on the same VPS.

**Prerequisites:** the VPS is already provisioned (Hostinger KVM1/KVM2,
Ubuntu 24.04). Node 20.20, MySQL 8, nginx 1.24, certbot 2.9, pm2 6 are
already installed for the orders project. Reuse them.

## 1. DNS

Create an A record on Squarespace DNS:

- Host: `finance`
- Type: A
- Points to: `187.77.100.23`
- TTL: 1hr

Verify: `nslookup finance.feldart.com` resolves to the VPS IP.

## 2. MySQL database + user

Connect as root or a privileged user:

```bash
ssh deploy@finance.feldart.com
sudo mysql
```

```sql
CREATE DATABASE feldart_finance CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'feldart_finance_app'@'localhost' IDENTIFIED BY '<generate-strong-pw>';
GRANT ALL PRIVILEGES ON feldart_finance.* TO 'feldart_finance_app'@'localhost';
FLUSH PRIVILEGES;
```

Note: separate user from `feldart_app` (orders project's user) — minimum
privilege per app.

## 3. Redis

If Redis isn't installed yet on the VPS:

```bash
sudo apt update
sudo apt install -y redis-server
sudo systemctl enable redis-server
sudo systemctl start redis-server
redis-cli ping  # → PONG
```

Bind to `127.0.0.1` only (default in Ubuntu's package). No password needed
for local-only use, but set one if paranoid:

```bash
sudo sed -i 's/^# requirepass .*/requirepass <generate-strong-pw>/' /etc/redis/redis.conf
sudo systemctl restart redis-server
```

If the orders project later needs Redis too, both apps share this instance
on different DB numbers (`REDIS_URL=redis://localhost:6379/0` vs `/1`).

## 4. App directory + .env.production

```bash
sudo -u deploy mkdir -p /home/deploy/finance-hub
sudo -u deploy chmod 700 /home/deploy/finance-hub
```

Copy `.env.example` from the repo to the VPS, rename, fill in real values:

```bash
# On the VPS, as the deploy user:
cd /home/deploy/finance-hub
nano .env.production
chmod 600 .env.production
chown deploy:deploy .env.production
```

Required env vars (see `.env.example` in the repo for the full list):

- `NODE_ENV=production`
- `PORT=3001`
- `PUBLIC_URL=https://finance.feldart.com`
- `DATABASE_URL=mysql://feldart_finance_app:<pw>@localhost:3306/feldart_finance`
- `REDIS_URL=redis://localhost:6379/0`
- `AUTH_SECRET=<openssl rand -hex 32>`
- `AUTH_URL=https://finance.feldart.com`
- `AUTH_GOOGLE_CLIENT_ID=...`
- `AUTH_GOOGLE_CLIENT_SECRET=...`
- `ALLOWED_EMAILS=you@example.com,teammate@example.com`
- `CRYPTO_KEY=<node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">`
- `ANTHROPIC_API_KEY=...`
- `MONDAY_API_TOKEN=...`
- `QB_CLIENT_ID=...` / `QB_CLIENT_SECRET=...` / `QB_REALM_ID=...` / `QB_REDIRECT_URI=https://finance.feldart.com/api/oauth/callback/quickbooks`
- `SHOPIFY_STORE_DOMAIN=...` / `SHOPIFY_ADMIN_TOKEN=...` / `SHOPIFY_API_VERSION=2024-10`
- `MONDAY_ENABLED=true` (mirror mode for now)
- `SENTRY_DSN=` (optional)

## 5. Google OAuth client redirect URIs

In Google Cloud Console, edit the existing "Feldart Production Orders"
OAuth client (or create a new one for finance-hub):

Authorized redirect URIs — add:
- `https://finance.feldart.com/api/auth/callback/google`
- `http://localhost:3001/api/auth/callback/google` (for local dev)

## 6. nginx site

Copy the site config:

```bash
sudo cp /home/deploy/finance-hub/deployment/nginx-finance.feldart.com.conf \
        /etc/nginx/sites-available/finance.feldart.com
sudo ln -s /etc/nginx/sites-available/finance.feldart.com \
           /etc/nginx/sites-enabled/finance.feldart.com
sudo nginx -t
sudo systemctl reload nginx
```

## 7. Let's Encrypt SSL

```bash
sudo certbot --nginx -d finance.feldart.com
# Email: ops@feldart.com (or whatever)
# Agree, no email-share, redirect HTTP→HTTPS: yes
```

`certbot.timer` is already set up by the orders project — no extra cron
needed; finance.feldart.com will auto-renew alongside orders.

## 8. GitHub Actions secrets

In `joshezekiel554-cloud/finance-hub` repo settings → Secrets and variables
→ Actions:

- `VPS_SSH_KEY` — same key as orders project (private key matching the
  public key already in `deploy@vps`'s `~/.ssh/authorized_keys`)
- `VPS_HOST` — `finance.feldart.com` (or the bare IP `187.77.100.23` —
  either works since DNS resolves)

## 9. First deploy

Push the main branch (or trigger via Actions UI). Watch for:

- Typecheck + build pass on runner
- rsync to `/home/deploy/finance-hub/`
- `npm ci --omit=dev` finishes
- `npm run db:migrate` applies all migrations cleanly (first run = full
  schema creation)
- pm2 starts `finance-hub` process
- Smoke test `curl https://finance.feldart.com/api/health` → 200

## 10. pm2 boot persistence

Already configured for the orders project (`pm2 startup` + `pm2 save`).
After first finance-hub deploy, run:

```bash
ssh deploy@vps
pm2 save
```

Now both apps survive reboots.
