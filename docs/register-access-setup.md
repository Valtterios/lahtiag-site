# Setting up register access (Google sign-in), the board webhook, and the import

One-time setup after the member register was deployed (September 2026).
Do the Google part with a **lahtiag.fi Workspace account**, not a personal
Gmail: only a project inside the lahtiag.fi organisation can be marked
Internal, and Internal is what keeps outsiders from even starting the
sign-in.

Every secret value goes to two places: the Worker (with `wrangler secret
put`, which prompts for the value so it never appears in a shell history)
and the maintainer's Bitwarden secure note for the site. Nothing is ever
committed.

## 1. Google Cloud project

1. Open `https://console.cloud.google.com/` and sign in with your
   lahtiag.fi account.
2. Top bar, project selector (next to the Google Cloud logo) → **New
   project**. Name `lahtiag-site`, Organisation `lahtiag.fi` (if the
   organisation field is missing, you are signed in with the wrong
   account). Create, then make sure the selector shows `lahtiag-site`.

## 2. Consent screen (Google Auth Platform)

1. Open `https://console.cloud.google.com/auth/overview` and click **Get
   started**.
2. App name `LahtiAG member register`, user support email `board@lahtiag.fi`
   (or your own).
3. Audience: **Internal**.
4. Contact email: your own. Agree, **Create**.

No scopes need adding: the site asks only for `openid email`, which are
not sensitive scopes.

## 3. OAuth client

1. Open `https://console.cloud.google.com/auth/clients` → **Create client**.
2. Application type **Web application**, name `lahtiag.fi`.
3. Authorised redirect URIs → Add URI:

   ```
   https://lahtiag.fi/auth/google/callback
   ```

   Nothing else is needed. (Only if previews should reach the register too:
   also add the preview Worker's `/auth/google/callback` URL.)
4. **Create**. A dialog shows the **Client ID** (ends in
   `.apps.googleusercontent.com`) and the **Client secret**. Copy both into
   the Bitwarden note now; the secret is not shown again later.

## 4. Put the values into the Worker

From the repository directory (each command prompts for the value: paste,
Enter):

```
cd ~/projects/lahtiag-site
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

If wrangler complains about not being logged in: `npx wrangler login` with
the lahtiagry@gmail.com Cloudflare account, then repeat.

## 5. Test

Open `https://lahtiag.fi/register`. It should say the register needs a
sign-in and offer **Sign in with Google**. Pick your lahtiag.fi account.
You should land on the register (empty until the import). If it says the
account can't open the register, the address is not on the list: the fixed
list is `REGISTER_ADMINS` in `wrangler.toml`, and everyone else is added
at the bottom of the register page by someone already on it.

## 6. Board webhook (new applications announced in Discord)

1. In Discord, open the board-only channel → channel settings (gear) →
   **Integrations** → **Webhooks** → **New Webhook**. Name it
   `LahtiAG site`, keep the channel, **Copy Webhook URL**.
2. Terminal:

   ```
   cd ~/projects/lahtiag-site
   npx wrangler secret put BOARD_WEBHOOK_URL
   ```

   Paste the URL, Enter. Also into Bitwarden. The message posted is only
   the applicant's name and school plus a link to the register.

## 7. Import the old sheet

1. In the nonprofit's Drive open the form's responses sheet → File →
   Download → **Comma-separated values (.csv)**.
2. Check the column mapping first (prints no personal data):

   ```
   cd ~/projects/lahtiag-site
   node scripts/import-register.mjs ~/Downloads/<file>.csv --dry-run
   ```

3. Generate and apply:

   ```
   node scripts/import-register.mjs ~/Downloads/<file>.csv > register.import.sql
   npx wrangler d1 execute lahtiag --remote --file=register.import.sql
   shred -u ~/Downloads/<file>.csv register.import.sql
   ```

   Rows already in the register (same email) are skipped, so re-running is
   safe. Imported people appear as members with the sheet's membership
   type; nothing is linked to Discord until they or the board link it.

## 8. Retire the Google Form

Google Forms → the membership form → **Responses** tab → switch off
**Accepting responses**, message: `Apply at https://lahtiag.fi/join`. Same
for the actives form. The site's Members page and front page already point
at /join.

## 9. Discord roles (Member and Actives)

The site can give linked members the **Member** role and approved actives
the **Actives** role. That needs a bot user, the one bot credential in the
whole system, used for roles and nothing else.

1. Discord Developer Portal → the LahtiAG application → **Bot**. If there
   is no bot user yet, add one. **Reset Token**, copy the token (shown
   once). Under Privileged Gateway Intents turn on **Server Members
   Intent** (the sync reads the member list).
2. Invite the bot: **OAuth2** → URL Generator → scope `bot`, permission
   **Manage Roles** only → open the URL, pick the LahtiAG server.
3. In the server: Server Settings → **Roles**. Create `Member` and
   `Actives` if they don't exist. Drag the bot's own role (named after the
   application) **above** both of them; Discord refuses otherwise.
4. Gate the actives channel: channel settings → Permissions → add the
   `Actives` role with View Channel, remove it from @everyone.
5. Set the token:

   ```
   cd ~/projects/lahtiag-site
   npx wrangler secret put DISCORD_BOT_TOKEN
   ```

6. On /register, scroll to **Discord roles**. It should say the bot is
   connected and list the server's roles: pick the Member and the Actives
   role, **Save roles**, then **Sync Discord roles** once. That gives every
   linked member the Member role and every approved active the Actives
   role, and removes either from people who shouldn't have it. Repeat if
   it says changes are left. (The choice is stored in the database; the
   `MEMBER_ROLE_ID` / `ACTIVES_ROLE_ID` vars in `wrangler.toml` are only a
   fallback and can stay empty.)
