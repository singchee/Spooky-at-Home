# Deployment — how the game gets online

*Where the game is hosted, how changes go live, and what you need to set up once*

## Recommendation: Vercel (free Hobby plan), connected to GitHub

| What happens | When |
|---|---|
| **Preview link** for every pull request, posted on the PR by Vercel's GitHub app | Each push to a PR branch |
| **Live site** updated | Each merge to `main` |

The preview links are the main reason to choose it: you can **play each PR on your phone before you tap merge**, which fits the "you tap merge" approach for phase 1.

The game is a static site (`npm run build` → `dist/`). It has no server and no database, and map data is fetched by the player's own browser, so any static host works. `vercel.json` sets the build and adds a **Content-Security-Policy** (a browser rule listing the only sites the page may contact). That turns the network allow-list in `docs/QUALITY.md` §4 from a convention into something the browser enforces.

### One-time setup (you, about 3 minutes; needs your accounts)
1. Go to vercel.com → **Sign up with GitHub**.
2. **Add New → Project** → import `singchee/Spooky-at-Home` → grant the Vercel GitHub app access to this repo only.
3. Framework preset: **Vite** (auto-detected). Leave the build settings as they are; `vercel.json` covers them. → **Deploy**.
4. Optional: Settings → Deployment Protection → keep preview links protected (only people logged in to your Vercel account can open them) until you want to share.

### Options compared

| Option | Previews per PR | Cost | Notes |
|---|---|---|---|
| **Vercel Hobby** (recommended) | Yes | Free | Hobby plan is for personal, non-commercial use [check current terms] |
| Cloudflare Pages | Yes | Free | Generous bandwidth; the better choice if the game goes commercial or gets busy |
| Netlify | Yes | Free tier | Similar to Vercel |
| GitHub Pages | No | Free for public repos; private repos need a paid GitHub plan [check] | No previews; simplest if the repo goes public |

### Privacy note
A public URL is fine: the game stores nothing on a server, and a player's address search goes from their browser straight to OpenStreetMap. Preview links are public by default unless you protect them (step 4).
