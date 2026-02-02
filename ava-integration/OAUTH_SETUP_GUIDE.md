# Google OAuth Setup Guide for AVA

Complete step-by-step guide to enable Google Calendar and Gmail for AVA

---

## 📋 Overview

AVA's `calendar_ops` and `comm_ops` tools require Google OAuth 2.0 credentials to access:
- **Google Calendar** - Create, read, update, delete events
- **Gmail** - Read, send emails

**Status**: ✅ Tools implemented and working | ⚠️ OAuth configuration required

---

## 🚀 Quick Setup (5 minutes)

### Prerequisites
- Google account
- Internet browser
- Administrator access to this computer

---

## Part 1: Google Calendar Setup

### Step 1: Create Google Cloud Project

1. Go to: **https://console.cloud.google.com**

2. Click **"Select a project"** dropdown (top left)

3. Click **"NEW PROJECT"**

4. Enter project details:
   - **Project name**: `AVA Assistant` (or your choice)
   - **Location**: Leave as default or select organization
   - Click **"CREATE"**

5. Wait for project creation (notification appears in top right)

6. Click **"SELECT PROJECT"** in the notification

### Step 2: Enable Google Calendar API

1. In the left sidebar, click **"APIs & Services"** → **"Library"**

2. Search for: `Google Calendar API`

3. Click on **"Google Calendar API"**

4. Click **"ENABLE"**

5. Wait for API to be enabled

### Step 3: Create OAuth Consent Screen

1. In left sidebar, click **"OAuth consent screen"**

2. Select **"External"** (unless you have Google Workspace)

3. Click **"CREATE"**

4. Fill out App Information:
   - **App name**: `AVA Assistant`
   - **User support email**: Your email
   - **Developer contact email**: Your email

5. Click **"SAVE AND CONTINUE"**

6. On "Scopes" page:
   - Click **"ADD OR REMOVE SCOPES"**
   - Search and select:
     - `.../auth/calendar` (See, edit, share, and permanently delete all calendars)
     - `.../auth/calendar.events` (View and edit events)
   - Click **"UPDATE"**
   - Click **"SAVE AND CONTINUE"**

7. On "Test users" page:
   - Click **"+ ADD USERS"**
   - Add your Google email address
   - Click **"ADD"**
   - Click **"SAVE AND CONTINUE"**

8. Review summary and click **"BACK TO DASHBOARD"**

### Step 4: Create OAuth 2.0 Credentials

1. In left sidebar, click **"Credentials"**

2. Click **"+ CREATE CREDENTIALS"** → **"OAuth client ID"**

3. Configure OAuth client:
   - **Application type**: Select **"Desktop app"**
   - **Name**: `AVA Desktop Client`

4. Click **"CREATE"**

5. A popup appears with **Client ID** and **Client Secret**:
   - Click **"DOWNLOAD JSON"**
   - **IMPORTANT**: Save this file!

### Step 5: Install Credentials for AVA

1. Locate the downloaded JSON file (usually in Downloads folder)
   - Name like: `client_secret_XXXXX.apps.googleusercontent.com.json`

2. Create `.cmpuse` directory if it doesn't exist:
   ```batch
   mkdir "%USERPROFILE%\.cmpuse"
   ```

3. Copy and rename the file:
   ```batch
   copy "Downloads\client_secret_*.json" "%USERPROFILE%\.cmpuse\calendar_credentials.json"
   ```

   Or manually:
   - Copy the downloaded JSON file
   - Rename it to: `calendar_credentials.json`
   - Move to: `C:\Users\USER 1\.cmpuse\`

### Step 6: Test Google Calendar Integration

1. Run the test script:
   ```batch
   cd "C:\Users\USER 1\ava-integration"
   python test_google_services.py
   ```

2. **First run will open browser**:
   - You'll see: "Google hasn't verified this app"
   - Click **"Advanced"**
   - Click **"Go to AVA Assistant (unsafe)"**
   - Click **"Allow"** to grant calendar permissions
   - Browser shows: "The authentication flow has completed"

3. **Token saved automatically**:
   - Location: `C:\Users\USER 1\.cmpuse\calendar_token.json`
   - This token will be reused for future requests

4. **Test results**:
   - Should now show your calendar events
   - Create/list/update operations will work

---

## Part 2: Gmail Setup

### Step 1: Enable Gmail API

1. Return to Google Cloud Console: **https://console.cloud.google.com**

2. Select your AVA project

3. Go to **"APIs & Services"** → **"Library"**

4. Search for: `Gmail API`

5. Click on **"Gmail API"**

6. Click **"ENABLE"**

### Step 2: Update OAuth Consent Screen Scopes

1. Go to **"OAuth consent screen"** in left sidebar

2. Click **"EDIT APP"**

3. Click **"SAVE AND CONTINUE"** on App information page

4. On "Scopes" page:
   - Click **"ADD OR REMOVE SCOPES"**
   - Search and add:
     - `.../auth/gmail.readonly` (Read emails)
     - `.../auth/gmail.send` (Send emails)
     - `.../auth/gmail.modify` (Modify email labels)
   - Click **"UPDATE"**
   - Click **"SAVE AND CONTINUE"**

5. Click through to Summary and **"BACK TO DASHBOARD"**

### Step 3: Create Gmail OAuth Credentials

**Option A: Reuse Calendar Credentials (Recommended)**

The Calendar credentials can be used for both APIs:

1. Copy calendar credentials:
   ```batch
   copy "%USERPROFILE%\.cmpuse\calendar_credentials.json" "%USERPROFILE%\.cmpuse\gmail_credentials.json"
   ```

**Option B: Create Separate Credentials**

1. Follow Steps 4-5 from Calendar Setup above

2. Save downloaded JSON as: `gmail_credentials.json`

### Step 4: Test Gmail Integration

1. Run the test script:
   ```batch
   cd "C:\Users\USER 1\ava-integration"
   python test_google_services.py
   ```

2. **First run will open browser**:
   - You'll see Gmail permission request
   - Click **"Advanced"** → **"Go to AVA Assistant (unsafe)"**
   - Click **"Allow"** for Gmail permissions
   - Browser shows: "The authentication flow has completed"

3. **Token saved automatically**:
   - Location: `C:\Users\USER 1\.cmpuse\gmail_token.json`

4. **Test results**:
   - Should now show your emails
   - Read/send operations will work

---

## ✅ Verification Checklist

After setup, verify these files exist:

```
C:\Users\USER 1\.cmpuse\
├── secrets.json                    ✅ (OpenAI API key)
├── calendar_credentials.json       ⚠️ (OAuth2 credentials for Calendar)
├── calendar_token.json             ⚠️ (Auto-created after first auth)
├── gmail_credentials.json          ⚠️ (OAuth2 credentials for Gmail)
└── gmail_token.json                ⚠️ (Auto-created after first auth)
```

---

## 🎯 Using Calendar & Gmail with AVA

### Calendar Examples

```python
# Via voice
"AVA, what's on my calendar today?"
"AVA, create a meeting tomorrow at 2 PM"
"AVA, find free time in my schedule"

# Via API
calendar_ops → action: list_events
calendar_ops → action: create_event
calendar_ops → action: get_today
calendar_ops → action: find_free_time
```

### Gmail Examples

```python
# Via voice
"AVA, check my unread emails"
"AVA, send an email to john@example.com"
"AVA, what emails did I get today?"

# Via API
comm_ops → action: read_emails, query: "is:unread"
comm_ops → action: send_email, to: "...", subject: "...", body: "..."
comm_ops → action: mark_read, message_id: "..."
```

---

## 🔒 Security Notes

### Your Data
- OAuth tokens stored locally: `C:\Users\USER 1\.cmpuse\`
- AVA only accesses what you authorize
- You can revoke access anytime at: https://myaccount.google.com/permissions

### Best Practices
1. **Never share** your `credentials.json` or `token.json` files
2. **Add to .gitignore** if using version control
3. **Tokens expire** - AVA will auto-refresh them
4. **Revoke access** from Google Account settings if needed

---

## 🛠️ Troubleshooting

### Error: "Calendar credentials not found"
- **Solution**: Ensure `calendar_credentials.json` exists in `C:\Users\USER 1\.cmpuse\`
- **Verify**: File is valid JSON and contains `client_id` and `client_secret`

### Error: "Gmail credentials not found"
- **Solution**: Copy `calendar_credentials.json` to `gmail_credentials.json`
- **Or**: Create separate OAuth credentials

### Browser doesn't open for authorization
- **Solution**: Check firewall settings
- **Manual**: Copy URL from terminal and paste in browser

### Error: "Google hasn't verified this app"
- **Solution**: This is normal for test apps
- **Fix**: Click "Advanced" → "Go to AVA Assistant (unsafe)"
- **Note**: Your data is safe - this warning is because app isn't published

### Token expired / Invalid grant
- **Solution**: Delete token files and re-authenticate:
  ```batch
  del "%USERPROFILE%\.cmpuse\calendar_token.json"
  del "%USERPROFILE%\.cmpuse\gmail_token.json"
  ```
- **Then**: Run AVA again - browser will open for re-auth

### Error: "Access blocked: This app's request is invalid"
- **Solution**: Verify OAuth consent screen is configured
- **Check**: Test users includes your email address

---

## 📝 Summary

**What you did**:
1. ✅ Created Google Cloud project
2. ✅ Enabled Calendar & Gmail APIs
3. ✅ Configured OAuth consent screen
4. ✅ Created OAuth 2.0 credentials
5. ✅ Installed credentials for AVA
6. ✅ Authorized AVA via browser

**What AVA can now do**:
- 📅 Read, create, update, delete calendar events
- 📧 Read emails, send emails, manage inbox
- 🔄 Automatic token refresh
- 🔒 Secure OAuth 2.0 authentication

**Next steps**:
- Test AVA voice commands with your calendar
- Try "AVA, check my emails"
- Set up other integrations (Twilio, Home Assistant, ElevenLabs)

---

## 📞 Quick Reference

**Test Command**:
```batch
cd "C:\Users\USER 1\ava-integration"
python test_google_services.py
```

**Credential Locations**:
- Calendar: `%USERPROFILE%\.cmpuse\calendar_credentials.json`
- Gmail: `%USERPROFILE%\.cmpuse\gmail_credentials.json`

**Token Locations** (auto-created):
- Calendar: `%USERPROFILE%\.cmpuse\calendar_token.json`
- Gmail: `%USERPROFILE%\.cmpuse\gmail_token.json`

**Google Console**: https://console.cloud.google.com
**Manage Access**: https://myaccount.google.com/permissions

---

**Setup Complete!** 🎉 AVA can now access your Google Calendar and Gmail!

*Last Updated: December 14, 2025*
