# 🏥 Therapy Tracker WhatsApp Bot

A professional WhatsApp bot to track therapy sessions with automatic summaries and reports.

## ✨ Features

- ✅ Log attended sessions with one message
- ❌ Track cancelled sessions with reasons
- 📊 Get monthly summaries in WhatsApp
- 🏖️ Mark planned holidays/absences
- 💰 Track costs and payments
- 🔄 Carry forward unused sessions

## 💰 Cost: 100% FREE for Personal Use

- WhatsApp Cloud API: FREE (1000 messages/month)
- Supabase Database: FREE (500MB storage)
- Render Hosting: FREE (512MB RAM)

## 📋 Prerequisites

- Facebook/Meta Developer account (free)
- Supabase account (free)
- Render account (free)
- Phone number for WhatsApp Business (can be your personal number)

---

## 🚀 Setup Instructions (40 minutes)

### Step 1: Setup WhatsApp Cloud API (15 mins)

1. **Go to Meta for Developers**
   - Visit: https://developers.facebook.com
   - Click "Get Started" or "My Apps"
   - Log in with Facebook account

2. **Create a New App**
   - Click "Create App"
   - Select "Business" as app type
   - Give it a name: "Therapy Tracker"
   - Click "Create App"

3. **Add WhatsApp Product**
   - In the app dashboard, find "WhatsApp"
   - Click "Set Up"
   - It will create a test number for you

4. **Get Your Credentials**
   - You'll see:
     - **Temporary Access Token** (copy this)
     - **Phone Number ID** (copy this)
   - Note: Temporary token expires in 24 hours, we'll make it permanent later

5. **Test the Number**
   - Add your personal phone number in "To" field
   - Send a test message to verify it works

6. **Make Token Permanent (Important!)**
   - Go to "Settings" → "System Users"
   - Create a system user: "Therapy Bot"
   - Generate permanent token with "whatsapp_business_messaging" permission
   - Replace temporary token with this permanent one

**Save these:**
- ✅ Permanent Access Token
- ✅ Phone Number ID

---

### Step 2: Setup Supabase Database (10 mins)

1. **Create Supabase Account**
   - Visit: https://supabase.com
   - Click "Start your project"
   - Sign up with GitHub or email

2. **Create New Project**
   - Click "New Project"
   - Name: "Therapy Tracker"
   - Database Password: (create strong password, save it!)
   - Region: Choose closest to you (e.g., Mumbai for India)
   - Click "Create new project" (takes 2 minutes)

3. **Create Database Tables**
   - Go to "SQL Editor" in left sidebar
   - Click "New Query"
   - Copy entire content from `database.sql` file
   - Paste and click "Run"
   - You should see "Success" message

4. **Get Your Credentials**
   - Go to "Settings" → "API"
   - Copy these:
     - **Project URL** (looks like: https://xxxxx.supabase.co)
     - **anon/public key** (the long key under "Project API keys")

**Save these:**
- ✅ Supabase URL
- ✅ Supabase Anon Key

---

### Step 3: Deploy on Render (10 mins)

1. **Create Render Account**
   - Visit: https://render.com
   - Sign up with GitHub (recommended) or email

2. **Create New Web Service**
   - Click "New +" → "Web Service"
   - Choose "Build and deploy from a Git repository"
   - Click "Next"

3. **Connect Your Code**
   
   **Option A - Use GitHub:**
   - Create new GitHub repository
   - Upload all bot files there
   - Connect repository in Render
   
   **Option B - Public Git:**
   - I'll provide a GitHub link
   - Just paste the link in Render

4. **Configure Service**
   - Name: `therapy-tracker-bot`
   - Region: Choose closest to you
   - Branch: `main`
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Plan: **Free** (select this!)

5. **Add Environment Variables**
   Click "Environment" tab and add:
   
   ```
   WHATSAPP_TOKEN = [your permanent access token from Step 1]
   PHONE_NUMBER_ID = [your phone number ID from Step 1]
   VERIFY_TOKEN = therapy_tracker_2025
   SUPABASE_URL = [your supabase URL from Step 2]
   SUPABASE_KEY = [your supabase anon key from Step 2]
   ```

6. **Deploy**
   - Click "Create Web Service"
   - Wait 5 minutes for deployment
   - Once deployed, copy your app URL (e.g., https://therapy-tracker-bot.onrender.com)

**Save this:**
- ✅ Render App URL

---

### Step 4: Connect WhatsApp to Your Server (5 mins)

1. **Go Back to Meta Developer Portal**
   - Open your Therapy Tracker app
   - Go to WhatsApp → Configuration

2. **Setup Webhook**
   - Find "Webhook" section
   - Click "Edit"
   - **Callback URL:** `https://your-render-url.onrender.com/webhook`
   - **Verify Token:** `therapy_tracker_2025`
   - Click "Verify and Save"

3. **Subscribe to Messages**
   - In "Webhook fields" section
   - Click "Manage"
   - Subscribe to "messages"
   - Click "Done"

4. **Test Connection**
   - Open WhatsApp on your phone
   - Message the WhatsApp Business number from Step 1
   - Type: `hello`
   - Bot should respond with welcome message!

---

## 🎉 You're Done! Start Using

### Daily Usage:

**Log Session:**
```
You: attended
Bot: ✅ Session logged for Feb 16!
     Today: 1 session
     This month: 14 sessions
     Remaining: 2 sessions
```

**Log Cancellation:**
```
You: missed
Bot: Why was the session cancelled?
You: therapist sick
Bot: ✓ Cancelled session recorded
```

**Get Summary:**
```
You: summary
Bot: [Beautiful formatted summary with all stats]
```

**Setup Monthly Config:**
```
You: setup
Bot: Please reply with:
     [sessions] [cost] [carry_forward]
     Example: 16 800 0
You: 16 800 0
Bot: ✅ Setup complete!
```

**Mark Holidays:**
```
You: holiday 3 days
Bot: ✓ Marked 3 days as planned absence
```

---

## 🔧 Troubleshooting

### Bot Not Responding?
1. Check Render logs: Go to your service → "Logs"
2. Verify webhook is connected in Meta portal
3. Check environment variables are set correctly

### Database Errors?
1. Verify database tables were created (check Supabase SQL Editor)
2. Check Supabase URL and key are correct
3. Try re-running database.sql

### WhatsApp Token Expired?
1. If using temporary token, it expires in 24 hours
2. Follow Step 1.6 to create permanent token
3. Update environment variable in Render

---

## 📱 Make It Production-Ready

### Add Your Own Phone Number:
1. In Meta portal, go to WhatsApp → API Setup
2. Add your business phone number
3. Verify with OTP
4. Now bot uses YOUR number instead of test number

### Add Multiple Users:
Bot automatically works for anyone who messages it!
- Your spouse can message same number
- Each user gets their own tracking

### Backup Your Data:
1. Go to Supabase → Database
2. Export tables periodically
3. Or setup automatic backups (paid feature)

---

## 🚀 Scale to Business

### When You Get Customers:

**Pricing Changes:**
- 1000+ messages/month: ₹500/month (WhatsApp)
- More database storage: ₹400/month (Supabase)
- Better hosting: ₹700/month (Render Pro)

**Multi-Tenant:**
- One bot serves multiple therapy centers
- Each center has separate data
- Easy to add: Just requires phone number tracking

**White Label:**
- Change bot messages to your branding
- Add your company name
- Custom features per client

---

## 📞 Support

If you face issues during setup:
1. Check Render logs for errors
2. Verify all environment variables
3. Test WhatsApp webhook in Meta portal
4. Check Supabase connection

---

## 📄 License

MIT License - Free to use and modify!

---

## 🎯 What's Next?

**Enhancements you can add:**
- Multiple therapist tracking
- Weekly reports
- Automatic reminders
- Export to Excel
- Voice message support
- Image/PDF receipt upload

Let me know if you need help adding any features!
