# SF Apartments

A tiny shared apartment-hunting tracker for me and a friend. Static site hosted on GitHub Pages. No backend, no database — apartment data lives in `data/apartments.json` in this repo and is read/written via the GitHub API.

## How it works

- HTML/CSS/JS, no build step.
- Each user enters a GitHub Personal Access Token in Settings; the app uses it to read and write `data/apartments.json`.
- Changes show up as normal commits on the `main` branch.

## One-time setup

### 1. Push this repo to GitHub

```bash
git add .
git commit -m "Initial commit"
gh repo create apartment-search --private --source=. --push
```

(Or use the web UI — public or private both work.)

### 2. Enable GitHub Pages

In the repo on github.com:

1. **Settings → Pages**
2. **Source**: Deploy from a branch
3. **Branch**: `main`, folder `/ (root)`
4. Save. After a minute, the site is live at `https://<your-username>.github.io/apartment-search/`.

### 3. Add your friend as a collaborator

**Settings → Collaborators → Add people.** They need write access so their token can update the JSON file.

### 4. Each person creates a Personal Access Token

1. Go to https://github.com/settings/tokens?type=beta
2. **Generate new token** (fine-grained)
3. **Repository access**: Only select repositories → choose `apartment-search`
4. **Permissions → Repository → Contents**: Read and write
5. Copy the token (starts with `github_pat_...`).

### 5. Open the site and click Settings

Enter your name, the repo (`owner/apartment-search`), and your token. Done.

## Notes

- Tokens are stored in `localStorage` in your browser only. They never leave your machine except as GitHub API auth headers.
- If two people edit at exactly the same time, the second save will get a conflict — just hit Refresh and re-save.
- All edits show up as commits, so git history is your audit log.

## Importing from Craigslist

There's a script that pulls SF apartments from Craigslist's public API and merges them into `data/apartments.json`.

```bash
# Default: latest SF apartments, up to 50, all prices/sizes
node scripts/import-craigslist.mjs

# Common filters
node scripts/import-craigslist.mjs --max-price=4000 --min-beds=1 --max-beds=2 --limit=30

# Free-text query
node scripts/import-craigslist.mjs --query="hardwood floors"

# Preview without writing
node scripts/import-craigslist.mjs --max-price=4500 --dry-run
```

Duplicates are skipped by URL. After running:

```bash
git add data/apartments.json && git commit -m "Import Craigslist listings" && git push
```

Then click **Refresh** in the web app.

The script uses Craigslist's JSON API — no auth, no rate limit issues at normal use, no Browserbase needed.

## Adding friends, gyms, and other places

The map shows additional points of interest from `data/places.json`. Add anything you want — friends, gyms, coffee shops, anything. Schema:

```json
{
  "category": "friends" | "gym" | "restaurant" | "coffee" | "grocery" | "park" | "transit" | "<your own>",
  "name": "Display name on the map",
  "address": "Street address",
  "type": "Optional: short type label (e.g. 'Bouldering + top rope')",
  "vibe": "Optional: longer description / vibe notes",
  "lat": 37.xxxx,
  "lon": -122.xxxx
}
```

Built-in categories have preset colors. `lat` / `lon` are optional — if missing, the app auto-geocodes the address via Nominatim on load (rate-limited to 1 req/sec). For best UX (instant render, no extra network call), prefer baking in the coords. Easiest way to get them:

```bash
curl -s "https://nominatim.openstreetmap.org/search?q=$(echo '959 Jackson St, San Francisco, CA' | sed 's/ /+/g')&format=json&limit=1" -H "User-Agent: my-app" | jq '.[0] | {lat, lon}'
```

After editing, commit and push — every collaborator will see the change.

## Local development

Just open `index.html` in a browser, or:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```
