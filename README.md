# Inkpage — ad-free manga & comic reader for Android

Offline reader with **no ads, no subscriptions, no accounts**.

**Formats:** CBZ/ZIP · CBR/RAR (v4 & v5) · CB7/7Z · CBT/TAR · PDF · image-based EPUB  
(File type is detected from the file's contents, so a mislabeled `.cbr` that is really a zip still opens.)

## Features
- **Library** with covers, search, sort, filters (Reading / Unread / Finished / Favorites), tags/collections, "Continue reading" shelf, long-press menu (favorite, rename, tag, mark read/unread, delete)
- **Reader modes:** Manga (right→left), Comic (left→right), Webtoon (vertical scroll)
- Pinch-zoom, double-tap zoom, swipe or tap-zone page turns, page slider, fit screen/width/height, double-page spread in landscape, dim slider, black/gray/white background, keep-screen-on
- **Reading time:** counts only while the reader is open, visible and recently touched (pauses after 90 s idle). Daily goal ring, streak, weekly chart, total time, pages read, most-read list
- Themes: Dark, AMOLED, Light, Sepia + 6 accent colours
- Progress, reading mode and finished status saved per book

## Get the APK (no Android Studio needed)
1. Create a new GitHub repository and push this folder to its `main` branch.
2. Open the repo's **Actions** tab → **Build Android APK** (it also runs on every push).
3. When it finishes (~5 min), download the **Inkpage-debug-apk** artifact, unzip, and install `app-debug.apk` on your phone (allow "Install unknown apps" for your file manager/browser).

## Build locally instead
Requirements: Node 18+, JDK 17, Android SDK.
```bash
npm install
npm run prepare-web
npx cap add android
npx cap sync android
cd android && ./gradlew assembleDebug
# APK: android/app/build/outputs/apk/debug/app-debug.apk
```
To try the UI in a desktop browser: `npm run prepare-web && npx serve www`

## Notes
- Books are copied into the app's private storage (IndexedDB). A 100–300 MB file is fine; multi-GB archives may be slow on low-RAM phones.
- Password-protected archives are not supported.
- Ideas for later: "Open with Inkpage" intent from file managers, folder import, chapter auto-grouping, a signed release build.
