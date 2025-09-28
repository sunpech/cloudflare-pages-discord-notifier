# Cloudflare Pages → Discord Deploy Notifier

A [Cloudflare Worker](https://workers.cloudflare.com/) with a cron trigger that monitors one or more Cloudflare Pages projects and posts a message to a Discord channel when a deployment starts and again when it finishes (success, failure, or skipped).

Cloudflare’s free plan doesn’t offer deploy notifications out-of-the-box. Netlify used to have this, but apparently not anymore (unless you had one in before they remove the interface).

If you’ve switched to Cloudflare Pages (or started there) and miss getting notified about deploy successes and failures, this Worker fills that gap — giving you free, automated Discord notifications without upgrading to a paid Cloudflare plan.

## 📑 Table of Contents

- [✨ Features](#-features)
- [🛠 Requirements](#-requirements)
- [🏁 Getting Started (Login)](#-getting-started-login)
- [🏗 Provisioning a New Worker Project](#-provisioning-a-new-worker-project)
- [📂 Project Structure](#-project-structure)
- [⚙️ Configuration](#️-configuration)
  - [1. Get Your Cloudflare Account ID](#1-get-your-cloudflare-account-id)
  - [2. Create a Cloudflare API Token](#2-create-a-cloudflare-api-token)
  - [3. Create a KV Namespace](#3-create-a-kv-namespace)
  - [4. Configure wrangler.toml](#4-configure-wranglertoml)
  - [5. Create a Discord Webhook](#5-create-a-discord-webhook)
  - [6. Store Secrets and Create Worker Project](#6-store-secrets-and-create-worker-project)
- [🚀 Deployment](#-deployment)
- [🧪 Testing and Troubleshooting (Optional)](#-testing-and-troubleshooting-optional)
- [🛡 Security](#-security)
- [📈 Roadmap / Ideas](#-roadmap--ideas)
- [⚠️ Disclaimer](#️-disclaimer)
- [📄 License](#-license)

## ✨ Features
* 🕒 Scheduled polling (every minute, or whatever interval you set via wrangler.toml)
*	📢 Discord notifications for:
    * 🚧 Deploy started
    * ✅ Successful deployments
    * ❌ Failed deployments
    * ⏭️ Skipped deployments (e.g. no changes detected)
*	🔑 Uses Cloudflare KV to remember the last deployment per project, so it only posts once per deploy
*	🔗 Supports multiple Pages projects in a single Worker (configured in wrangler.toml)
*	🔒 Secure secrets — no tokens or webhooks are committed to source control
* 💡 Not implemented yet, but the Worker code could be extended to include branch name, commit message, or custom formatting in notifications

## 🛠 Requirements

Before using this project, make sure you have:

- **One or more projects deployed on Cloudflare Pages**  
  (This Worker monitors those projects for new deployments)
- **Node.js & npm** – Install from [nodejs.org](https://nodejs.org/)  
  (Recommended: use an LTS version such as 20.x or 22.x)
- **npx** – Comes with npm 5.2+ (used to run Wrangler without a global install)
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) – Installed as a dev dependency. See: [Install/Update Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- A **Cloudflare account** with:
  - Access to [Cloudflare Pages](https://developers.cloudflare.com/pages/)
  - An **API token** with `Account → Cloudflare Pages → Read` permission
- A **Discord webhook URL** for the channel you want notifications to appear in

## 🏁 Getting Started (Login)

Before configuring anything, make sure Wrangler is logged in to your Cloudflare account. It helps if you are already logged into Cloudflare in your default web browser.

Run:

```
npx wrangler login
```

Your browser should open up with Wrangler asking to make changes to your Cloudflare account. Click 'Allow'.

![Screenshot-01](/images/screenshot-01.png)

![Screenshot-02](/images/screenshot-02.png)

If you ever need to switch accounts or reset authentication, run:

```
npx wrangler logout
```

## 🏗 Provisioning a New Worker Project

**Recommended:** Clone this repository and follow the instructions below.

That ensures you have the correct `src/index.ts`, `wrangler.toml`, and project structure for this notifier.  

When you add your secrets with `npx wrangler secret put` (or when you run `npx wrangler deploy`), Wrangler will prompt you to create the Worker project automatically using the `name` from `wrangler.toml`.

This is the easiest way to provision everything with the right name and bindings.

---

### (Optional) Manual Scaffolding

If you want to start from scratch rather than cloning this repo, you can bootstrap a new Worker project with Wrangler:

```
npm create cloudflare@latest
```

Follow the prompts to:
* Choose “Hello World” Worker template
* Select TypeScript (recommended)
* Name the project (e.g., cloudflare-pages-discord-notifier)
* Install dependencies

Then copy this repository’s src/index.ts and wrangler.toml as references to configure your project.

## 📂 Project Structure

```
cloudflare-pages-discord-notifier/
├── wrangler.toml       # Worker config (cron schedule, KV binding, vars)
├── package.json        # Dev dependencies & scripts
├── package-lock.json   # (auto-generated by npm)
├── src/
│   └── index.ts        # Worker code (cron handler + Discord posting)
└── README.md
```

## ⚙️ Configuration

### 1. Get Your Cloudflare Account ID

Your `ACCOUNT_ID` is required to call the Pages API.  
You can find it in a few ways:

- **Dashboard URL:**  
  Log into the Cloudflare dashboard → go to **Workers & Pages**.  
  Look at the browser URL: `https://dash.cloudflare.com/<ACCOUNT_ID>/workers-and-pages`
  Copy the long hex string after `dash.cloudflare.com/`.
- **CLI (Wrangler):**

```
npx wrangler whoami
```

This lists your accounts and their IDs.

You’ll use this value in wrangler.toml under [vars].

### 2. Create a Cloudflare API Token

Your Worker needs a Cloudflare API token with **read-only access** to your Pages projects.

1. Go to [Cloudflare Dashboard → My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens)
2. Click Create Token → Create Custom Token
3. Add 1 permission:
    *	Account → Cloudflare Pages → Read
4. Scope to your account under Account Resources → Include → Specific Account
5. No Zone resources needed — leave them blank.
6. Name it (e.g. pages-read-worker) and create it.
7. Copy the token value — you’ll store it securely later.



### 3. Create a KV Namespace

Your Worker uses Cloudflare KV to remember the last deployment ID per project.

Create the namespace:
```
npx wrangler kv namespace create STATE
```

You’ll see output like:

```
kv_namespaces = [
  { binding = "STATE", id = "e3a9b123456f4a9db5e12345678a9b12" }
]
```

Copy the id value exactly into wrangler.toml.

If you wish to delete the namespace, first let's list what's there:

```
npx wrangler kv namespace list
```

Delete it.
```
npx wrangler kv namespace delete --namespace-id <THE_ID>
```


### 4. Configure wrangler.toml

Edit wrangler.toml and fill in placeholders:
```
name = "cloudflare-pages-discord-notifier"
main = "src/index.ts"
compatibility_date = "2024-11-01"

kv_namespaces = [
  { binding = "STATE", id = "e3a9b123456f4a9db5e12345678a9b12" }
]

[vars]
ACCOUNT_ID = "your_cloudflare_account_id"
PROJECTS = """["small-site","docs-site","big-gallery"]"""

[triggers]
crons = ["*/5 * * * *"]  # every 5 minutes (can be every minute)
```

### 5. Create a Discord Webhook

How to create Discord webhooks: [Intro to Webhooks](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks)

This project uses a Discord webhook to send deployment notifications into a channel of your choice.

1. Open Discord and go to the **server** where you want notifications.
2. Create or choose a **text channel** for deploy notifications.
3. Go to **Channel Settings → Integrations → Webhooks**.
4. Click **New Webhook**.
   - Give it a name (e.g., `Cloudflare Deploy Bot`)
   - Choose the channel
   - (Optional) Set an avatar to make notifications look nicer
5. Copy the **Webhook URL** (it will look like `https://discord.com/api/webhooks/...`).

You will use this URL when storing the `DISCORD_WEBHOOK` secret:

### 6. Store Secrets and Create Worker Project

Use Wrangler to securely store your API token and Discord webhook:

```
npx wrangler secret put CF_API_TOKEN
npx wrangler secret put DISCORD_WEBHOOK
```
Paste the values when prompted. Wrangler will encrypt and store them in Cloudflare.

![Screenshot-03](/images/screenshot-03.png)

💡 Note: If this is the first time you are interacting with this Worker (and it hasn’t been deployed yet),
Wrangler will prompt you to create the Worker project using the name defined in wrangler.toml.
Choose Yes — this is expected and will create the Worker in your account.

## 🚀 Deployment

```
npm install
npx wrangler deploy
```

✅ Note: On your first successful deploy, this Worker will not yet have any recorded state in KV.


That means for each project listed in PROJECTS, you’ll immediately receive:
- 🚧 A "Deploy started" notification (if the latest deploy is still running)
- ✅/❌/⏭️ A notification when the same deploy finishes (success, failure, or skipped)

Subsequent runs will only notify when new deployments start or finish.

## 🧪 Testing and Troubleshooting (Optional)

This section is for verifying your configuration or debugging issues if something goes wrong.  

If `npx wrangler deploy` worked and your Worker was created successfully, you can skip this section entirely.

### 1. Verify Your Cloudflare API Token & Config

If `npx wrangler deploy` fails, or if you want to confirm your credentials before deploying,  
you can manually test your API token, account ID, and project name with a `curl` request:

```
curl "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/pages/projects/$PROJECT_NAME/deployments?per_page=1" --request GET --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

Replace:
* $ACCOUNT_ID with the value you got earlier
* $PROJECT_NAME with the exact case-sensitive name of one Pages project you want to monitor
(if you have multiple projects, just pick one to test with)
* $CLOUDFLARE_API_TOKEN with the token you created

You should get JSON back with a result array containing your latest deployment(s).

For reference, see [Cloudflare Pages API documentation](https://developers.cloudflare.com/pages/configuration/api/).

### 2. Run the Worker Locally

You can simulate the cron run locally:
```
npx wrangler dev --test-scheduled
```

### 3. Tail Logs in Production

Stream live logs after deploying:
```
npx wrangler tail
```

### 4. Force a New Notification

Delete the last-known deployment ID in KV to trigger a new notification on the next run:
```
npx wrangler kv key delete "last:project-name" --binding=STATE
```

## 🛡 Security
* API Token: Use a custom token with Account → Cloudflare Pages → Read permission only.
* Webhook URL: Keep it secret (anyone with it can post to your Discord channel).
* KV Data: Stores only the last deployment ID per project.

## 📈 Roadmap / Ideas
* Add commit message and branch name to Discord notifications
* Send different projects to different Discord channels
* Use Discord embeds for richer, color-coded messages

## ⚠️ Disclaimer

This project was "vibe-coded" with the assistance of ChatGPT.

While functional and tested, parts of the code were generated with AI suggestions,  
so you may want to review it carefully before using in production or extending it.

## 📄 License

MIT License

Copyright (c) 2025

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.