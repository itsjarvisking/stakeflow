# StakeFlow Deployment Guide

## Current Status
- ✅ App icons generated
- ✅ iOS project configured
- ✅ Android project configured
- ✅ Capacitor synced

## On Your Mac (with Xcode)

### 1. Copy the project
The project is at: `/Users/jarvis/clawd/stakeflow`

Copy to your Mac or access via shared folder/git.

### 2. Open iOS Project
```bash
cd stakeflow
npx cap open ios
```

### 3. In Xcode:
1. Select your Team (Apple Developer Account)
2. Set Bundle Identifier: `work.stakeflow.app`
3. Select a real device or simulator
4. Product → Archive (for App Store) or Run (for testing)

### 4. For App Store Submission:
1. Product → Archive
2. Window → Organizer
3. Distribute App → App Store Connect
4. Upload

## Android Build

### Build Debug APK (for testing):
```bash
cd stakeflow/android
./gradlew assembleDebug
```
APK will be at: `android/app/build/outputs/apk/debug/app-debug.apk`

### Build Release APK/AAB (for Play Store):
```bash
cd stakeflow/android
./gradlew bundleRelease
```

## Backend Deployment

Currently using Cloudflare tunnel (temporary). For production:

### Option 1: Railway (Recommended)
```bash
railway login
railway init
railway up
```

### Option 2: Render
1. Connect GitHub repo
2. Set build command: `npm install`
3. Set start command: `npm start`

### After deploying backend:
Update `dist/config.js` with the new URL:
```javascript
window.STAKEFLOW_API = 'https://your-backend-url.com';
```
Then run `npx cap sync`

## App Store Requirements

### iOS (App Store Connect)
- Apple Developer Account ($99/year)
- App screenshots (6.5" and 5.5" iPhone)
- App description
- Privacy policy URL
- App icon (done ✅)

### Android (Play Console)
- Google Play Developer Account ($25 one-time)
- App screenshots
- Feature graphic (1024x500)
- App description
- Privacy policy URL
- App icon (done ✅)
