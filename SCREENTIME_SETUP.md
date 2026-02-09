# Screen Time API Setup for StakeFlow

## Overview
The Screen Time API (Family Controls) allows StakeFlow to block ALL apps during focus sessions, showing a "forfeit stake" prompt when users try to open blocked apps.

## Requirements
- iOS 15.0+
- Apple Developer Account ($99/year)
- Family Controls entitlement (requires Apple approval)

## Setup Steps

### 1. Request Family Controls Capability
1. Go to [Apple Developer Portal](https://developer.apple.com/account)
2. Navigate to Certificates, Identifiers & Profiles → Identifiers
3. Select your App ID (or create one for `com.stakeflow.app`)
4. Under Capabilities, enable **Family Controls**
5. Apple will review this request (usually 1-3 days)

### 2. Add Entitlements in Xcode
1. Open `ios/App/App.xcworkspace` in Xcode
2. Select the App target → Signing & Capabilities
3. Click "+ Capability" and add:
   - **Family Controls**
4. This creates/updates `App.entitlements` file

### 3. Add Frameworks
In Xcode, add these frameworks to your target:
- FamilyControls.framework
- ManagedSettings.framework
- DeviceActivity.framework

### 4. Create Shield Configuration Extension (Optional but Recommended)
For custom "forfeit stake" UI when apps are blocked:

1. File → New → Target
2. Choose "Shield Configuration Extension"
3. Name it "StakeFlowShield"
4. This shows your custom UI instead of the default Screen Time shield

### 5. Register the Capacitor Plugin
Add to `ios/App/App/AppDelegate.swift`:

```swift
import Capacitor

// In application(_:didFinishLaunchingWithOptions:)
if #available(iOS 15.0, *) {
    bridge?.registerPluginInstance(ScreenTimePlugin())
}
```

### 6. JavaScript Integration
In your web app:

```javascript
// Request Screen Time permission (do this once, early)
async function requestScreenTimeAccess() {
    if (window.Capacitor?.Plugins?.ScreenTimePlugin) {
        const result = await Capacitor.Plugins.ScreenTimePlugin.requestAuthorization();
        return result.authorized;
    }
    return false;
}

// Start blocking when focus session begins
async function startFocusLock() {
    if (window.Capacitor?.Plugins?.ScreenTimePlugin) {
        await Capacitor.Plugins.ScreenTimePlugin.startBlocking();
    }
}

// Stop blocking when session ends
async function stopFocusLock() {
    if (window.Capacitor?.Plugins?.ScreenTimePlugin) {
        await Capacitor.Plugins.ScreenTimePlugin.stopBlocking();
    }
}
```

## What Gets Blocked
- **Blocked:** All apps, games, social media, browsers
- **Allowed:** Phone, Messages (iMessage/SMS), and StakeFlow itself
- **Shield shows:** Custom prompt asking "Forfeit $X stake to open this app?"

## Shield Configuration Extension
To show a custom "forfeit" dialog:

Create `ShieldConfigurationExtension/ShieldConfigurationExtension.swift`:

```swift
import ManagedSettingsUI

class ShieldConfigurationExtension: ShieldConfigurationDataSource {
    override func configuration(shielding application: Application) -> ShieldConfiguration {
        return ShieldConfiguration(
            backgroundBlurStyle: .systemUltraThinMaterial,
            backgroundColor: .black,
            icon: UIImage(named: "shield-icon"),
            title: ShieldConfiguration.Label(text: "Stay Focused!", color: .white),
            subtitle: ShieldConfiguration.Label(text: "Opening this app will forfeit your stake", color: .gray),
            primaryButtonLabel: ShieldConfiguration.Label(text: "Forfeit Stake", color: .red),
            primaryButtonBackgroundColor: .clear,
            secondaryButtonLabel: ShieldConfiguration.Label(text: "Stay Focused", color: .green)
        )
    }
}
```

## Testing
1. Build and run on a **real device** (Simulator doesn't support Screen Time)
2. Grant Screen Time permission when prompted
3. Start a focus session
4. Try to open another app - should show the shield

## Notes
- Screen Time API is LOCAL ONLY - no server calls needed
- Works offline
- Blocking persists even if app is killed (use DeviceActivity schedule)
- User can always override via Settings → Screen Time (but that's obvious they're cheating)

## Troubleshooting
- **"Authorization failed"**: Make sure Family Controls entitlement is approved by Apple
- **Shield not showing**: Must test on real device, not simulator
- **Apps not blocked**: Check that ManagedSettingsStore is properly configured
