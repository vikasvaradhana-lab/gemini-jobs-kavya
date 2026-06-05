# Kavya's Auto-Updating Job Board - Setup Guide

## Overview
This is a **fully independent job board** that auto-updates daily without any manual intervention. The system has three parts:

1. **API Server** (Node.js) - Stores and serves job data
2. **GitHub Actions Scraper** - Runs daily, fetches fresh jobs, posts to API
3. **HTML Dashboard** - Kavya opens it, clicks refresh, gets fresh jobs from the API

---

## Step 1: Deploy the API Server

You can deploy the API for **FREE** on Render.com or Railway.app.

### Option A: Deploy on Render (Recommended)

1. Go to https://render.com (sign up with GitHub account)
2. Click "New +" → "Web Service"
3. Connect your GitHub repository
4. Fill in:
   - **Name**: `kavya-job-board-api`
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Free Plan**: Select (auto-sleeps after 15 mins of inactivity, but wakes on requests)

5. Click "Deploy"
6. **Copy your deployed URL** (e.g., `https://kavya-job-board-api.onrender.com`)

### Option B: Deploy on Railway.app

1. Go to https://railway.app (sign up with GitHub)
2. Click "Create New Project" → "Deploy from GitHub repo"
3. Connect your repo
4. Railway auto-detects Node.js
5. Add environment variable:
   - Key: `API_KEY`
   - Value: `your-secret-key-here` (make it strong)
6. Click "Deploy"
7. **Copy your deployed URL**

---

## Step 2: Set Up GitHub Actions Secrets

The scraper needs to authenticate with your API.

1. Go to your GitHub repository
2. Settings → Secrets and variables → Actions
3. Click "New repository secret"
4. Add two secrets:

   **Secret 1:**
   - Name: `API_URL`
   - Value: `https://your-deployed-url-here` (e.g., `https://kavya-job-board-api.onrender.com`)

   **Secret 2:**
   - Name: `API_KEY`
   - Value: `your-secret-key` (same as the one you set in the API environment variables)

5. Click "Add secret"

---

## Step 3: Enable GitHub Actions

1. Go to your repository
2. Click "Actions" tab
3. You should see the "Daily Job Board Update" workflow
4. Click "Enable workflow" if needed
5. The workflow will run automatically every day at 8 AM UTC

### Manual Test

To test immediately:
1. Go to Actions tab
2. Click "Daily Job Board Update"
3. Click "Run workflow" → "Run workflow"
4. Wait 1-2 minutes for it to complete

---

## Step 4: Update the HTML Dashboard

In `job_board_connected.html`, find this line at the top:

```javascript
const API_URL = 'https://your-api-url.herokuapp.com';
```

Replace it with your actual API URL:

```javascript
const API_URL = 'https://kavya-job-board-api.onrender.com';
```

---

## Step 5: Give Kavya the HTML File

1. Download `job_board_connected.html`
2. Send it to Kavya
3. She can:
   - Open it in any browser (works offline too)
   - Click "Refresh Board" to fetch latest jobs from your API
   - The board updates automatically every day via GitHub Actions

---

## How It Works (Daily Flow)

1. **8 AM UTC every day**: GitHub Actions triggers
2. **Scraper runs**: Fetches from EURAXESS, curated portals, etc.
3. **Posts to API**: Stores fresh jobs in the database
4. **Kavya clicks Refresh**: Dashboard fetches from API and shows new jobs
5. **Popup appears**: Shows how many new matches were found

---

## Customization

### Change Scraping Time
Edit `.github/workflows/job-board-update.yml`:
```yaml
- cron: '0 8 * * *'  # Currently 8 AM UTC
```

Change the time (format: `minute hour * * *`):
- `0 9 * * *` = 9 AM UTC
- `0 14 * * *` = 2 PM UTC

### Add More Job Sources
Edit `.github/workflows/scraper.js`:
- Add new portals to the scraping logic
- Keep the same job format for consistency

### Change Filter Criteria
Edit `.github/workflows/scraper.js`:
- Modify `KAVYA_SKILLS` array to add/remove keywords
- Modify `EXCLUDE_KEYWORDS` to filter out irrelevant roles

---

## Troubleshooting

### API not connecting?
- Check that `API_URL` in the HTML matches your deployed API URL
- Test the API: Open `https://your-api-url/api/health` in browser

### Jobs not updating?
- Go to GitHub Actions tab and check the workflow logs
- Look for errors in the scraper logs

### Too many/too few jobs showing?
- Adjust the scoring logic in `.github/workflows/scraper.js`
- Change the `score >= 65` threshold to be stricter/looser

---

## What Kavya Sees

When she clicks "Refresh Board":

✅ **Loading overlay** - 2.4 seconds showing scraping progress
✅ **Popup** - Shows "X new quality matches found"
✅ **Fresh jobs** - Board updates with latest positions
✅ **Filter controls** - Can still filter by country, tier, type
✅ **Track status** - Can mark jobs as Applied/Rejected/Closed

---

## Cost

This is **100% FREE**:
- Render.com: Free tier (sleeps after 15 mins, but wakes on requests)
- Railway.app: Free tier ($5 monthly credit, more than enough)
- GitHub Actions: Free tier (2000 minutes/month)
- API costs: $0

---

## Support

If something breaks:
1. Check GitHub Actions logs (Actions tab → workflow run)
2. Check API health (visit `/api/health` endpoint)
3. Review the error messages in both logs

The HTML dashboard has a fallback - even if the API is down, Kavya can still see her curated jobs from `INITIAL_JOBS`.

---

**That's it! Kavya now has a fully automated, self-updating job board.** 🎯
