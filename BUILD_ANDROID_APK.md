# Building Android APK for XAUUSD Signal Bot

## Prerequisites

Before building the Android APK, ensure you have:

1. **Node.js** (v18 or higher)
2. **Bun** (Package manager used by this project)
3. **Expo CLI** (Included in project dependencies)
4. **EAS CLI** (Expo Application Services)
5. **Android Studio** (Optional, for local builds)
6. **Java JDK 17** (For local builds)

---

## Method 1: Build with EAS (Recommended)

EAS (Expo Application Services) is the recommended way to build production-ready APKs.

### Step 1: Install EAS CLI

```bash
npm install -g eas-cli
```

### Step 2: Login to Expo

```bash
eas login
```

If you don't have an Expo account, create one at [expo.dev](https://expo.dev)

### Step 3: Configure EAS Build

Create an `eas.json` file in the project root:

```json
{
  "cli": {
    "version": ">= 7.0.0"
  },
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal",
      "android": {
        "gradleCommand": ":app:assembleDebug",
        "buildType": "apk"
      }
    },
    "preview": {
      "distribution": "internal",
      "android": {
        "buildType": "apk"
      }
    },
    "production": {
      "android": {
        "buildType": "app-bundle"
      }
    }
  },
  "submit": {
    "production": {}
  }
}
```

### Step 4: Update app.json

Ensure your `app.json` includes proper Android configuration:

```json
{
  "expo": {
    "name": "XAUUSD Signal Bot",
    "slug": "xauusd-signal-bot",
    "version": "1.1.0",
    "orientation": "portrait",
    "icon": "./assets/images/icon.png",
    "scheme": "xauusd-bot",
    "userInterfaceStyle": "automatic",
    "newArchEnabled": true,
    "splash": {
      "image": "./assets/images/splash-icon.png",
      "resizeMode": "contain",
      "backgroundColor": "#0a0a0a"
    },
    "ios": {
      "supportsTablet": true,
      "bundleIdentifier": "com.xauusdbot.app"
    },
    "android": {
      "adaptiveIcon": {
        "foregroundImage": "./assets/images/adaptive-icon.png",
        "backgroundColor": "#0a0a0a"
      },
      "package": "com.xauusdbot.app",
      "permissions": [
        "INTERNET",
        "ACCESS_NETWORK_STATE"
      ],
      "versionCode": 1
    },
    "web": {
      "bundler": "metro",
      "output": "server",
      "favicon": "./assets/images/favicon.png"
    },
    "plugins": [
      "expo-router"
    ],
    "experiments": {
      "typedRoutes": true
    }
  }
}
```

### Step 5: Build APK for Preview/Testing

```bash
eas build --platform android --profile preview
```

This will:
- Build an APK (not AAB)
- Upload to Expo servers
- Provide a download link

### Step 6: Build for Production (Google Play Store)

```bash
eas build --platform android --profile production
```

This will:
- Build an AAB (Android App Bundle) for Play Store
- Optimize the bundle size
- Sign with release keystore

---

## Method 2: Local Build (Android Studio Required)

### Step 1: Generate Android Native Project

```bash
npx expo prebuild --platform android
```

This creates an `android/` directory with the full Android project.

### Step 2: Open Android Studio

1. Open Android Studio
2. Select "Open an Existing Project"
3. Navigate to the `android/` folder in your project
4. Wait for Gradle sync to complete

### Step 3: Build Debug APK

In Android Studio:
1. **Build** > **Build Bundle(s) / APK(s)** > **Build APK(s)**
2. Wait for build to complete
3. APK location: `android/app/build/outputs/apk/debug/app-debug.apk`

### Step 4: Build Release APK

1. Generate a signing key (first time only):

```bash
cd android/app
keytool -genkeypair -v -storetype PKCS12 -keystore my-release-key.keystore -alias my-key-alias -keyalg RSA -keysize 2048 -validity 10000
```

2. Add signing config to `android/app/build.gradle`:

```gradle
android {
    ...
    signingConfigs {
        release {
            storeFile file('my-release-key.keystore')
            storePassword 'your-password'
            keyAlias 'my-key-alias'
            keyPassword 'your-password'
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
            minifyEnabled true
            proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
        }
    }
}
```

3. Build release APK:

```bash
cd android
./gradlew assembleRelease
```

4. APK location: `android/app/build/outputs/apk/release/app-release.apk`

---

## Method 3: Command Line Build (No Android Studio)

### Step 1: Install Java JDK 17

Download from: https://www.oracle.com/java/technologies/javase/jdk17-archive-downloads.html

Verify installation:
```bash
java -version
```

### Step 2: Install Android SDK Command Line Tools

1. Download from: https://developer.android.com/studio#command-tools
2. Extract to a directory (e.g., `~/Android/sdk`)
3. Set environment variables:

```bash
export ANDROID_HOME=~/Android/sdk
export PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin
export PATH=$PATH:$ANDROID_HOME/platform-tools
```

4. Install required SDK components:

```bash
sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"
```

### Step 3: Generate Android Project

```bash
npx expo prebuild --platform android
```

### Step 4: Build APK

```bash
cd android
./gradlew assembleDebug    # For debug APK
./gradlew assembleRelease  # For release APK (requires signing)
```

---

## Installing APK on Device

### Via ADB (USB Connection)

1. Enable USB Debugging on Android device
2. Connect device via USB
3. Verify connection:

```bash
adb devices
```

4. Install APK:

```bash
adb install path/to/app-debug.apk
```

### Via File Transfer

1. Copy APK to device
2. Open file on device
3. Allow "Install from Unknown Sources" if prompted
4. Tap "Install"

---

## Troubleshooting

### Build Errors

#### "Android SDK not found"
- Set `ANDROID_HOME` environment variable
- Install Android SDK

#### "Gradle build failed"
- Run `cd android && ./gradlew clean`
- Try building again

#### "Out of memory"
- Increase Gradle memory in `android/gradle.properties`:
```
org.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspermSize=512m
```

### APK Not Installing

#### "App not installed"
- Uninstall previous version
- Clear app data
- Check device storage

#### "Parse error"
- APK is corrupted
- Rebuild APK
- Check if device architecture is supported

---

## Optimizing APK Size

### Enable ProGuard (Minification)

In `android/app/build.gradle`:

```gradle
buildTypes {
    release {
        minifyEnabled true
        shrinkResources true
        proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
    }
}
```

### Enable App Bundles (For Play Store)

```bash
eas build --platform android --profile production
```

This creates an AAB which:
- Is 15-30% smaller than APK
- Generates optimized APKs per device
- Required for Play Store submissions

---

## Continuous Integration

### GitHub Actions Example

Create `.github/workflows/build-android.yml`:

```yaml
name: Build Android APK

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: 18
      
      - name: Setup Bun
        uses: oven-sh/setup-bun@v1
      
      - name: Install dependencies
        run: bun install
      
      - name: Setup EAS
        uses: expo/expo-github-action@v8
        with:
          eas-version: latest
          token: ${{ secrets.EXPO_TOKEN }}
      
      - name: Build APK
        run: eas build --platform android --profile preview --non-interactive
```

---

## App Signing for Play Store

### Generate Upload Key

```bash
keytool -genkeypair -v -storetype PKCS12 -keystore upload-key.keystore -alias upload -keyalg RSA -keysize 2048 -validity 10000
```

### Configure EAS for Auto-Signing

In `eas.json`:

```json
{
  "build": {
    "production": {
      "android": {
        "buildType": "app-bundle"
      }
    }
  }
}
```

EAS will:
- Generate signing keys automatically
- Store them securely in Expo servers
- Sign your app bundle

---

## Testing APK

### Manual Testing Checklist

- [ ] App launches successfully
- [ ] Login works without password (demo mode)
- [ ] Live gold price fetches correctly
- [ ] TradingView chart displays
- [ ] Signal generation works
- [ ] Settings save correctly
- [ ] History tab shows signals
- [ ] Market outlook updates
- [ ] Performance metrics calculate
- [ ] App works offline (uses cached data)
- [ ] No crashes or errors in logs

### Performance Testing

```bash
adb shell dumpsys meminfo com.xauusdbot.app
```

Check:
- Memory usage < 150 MB
- No memory leaks
- Smooth 60 FPS rendering

---

## Deployment Checklist

Before releasing to production:

- [ ] Update version in `app.json`
- [ ] Update version code for Android
- [ ] Test on multiple devices
- [ ] Check all permissions are necessary
- [ ] Verify API keys are not hardcoded
- [ ] Test with production API endpoints
- [ ] Run ProGuard/R8 optimization
- [ ] Test release build thoroughly
- [ ] Create release notes
- [ ] Submit to Play Store

---

## Additional Resources

- **Expo Build Documentation**: https://docs.expo.dev/build/introduction/
- **Android Developer Guide**: https://developer.android.com/guide
- **EAS Build**: https://docs.expo.dev/build/setup/
- **React Native Performance**: https://reactnative.dev/docs/performance

---

## Support

For build issues specific to this project, refer to:
- `SYSTEM_V1.1_DOCUMENTATION.md` - System architecture
- `README.md` - Project overview
- Console logs during build for detailed errors
