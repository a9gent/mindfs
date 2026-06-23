# MindFS HarmonyOS NEXT Shell

This is the Stage/ArkTS shell for the pure HarmonyOS target.

Current scope:

- Loads MindFS web assets from `entry/src/main/resources/rawfile/public/index.html`.
- Registers `window.MindFSNative` and `window.MindFSHarmony` for the shared frontend.
- Keeps Android behavior separate; Android still uses the existing Capacitor project.

Build web assets into this shell:

```sh
cd ../web
npm run build:harmony
```

Open the `harmony/` directory in DevEco Studio after the web assets are built.

Signing material is intentionally not committed. For local DevEco runs, configure
signing from DevEco Studio Project Structure > Project > Signing Configs, or let
DevEco generate a local debug signature. Keep `.cer`, `.p12`, and `.p7b` files
outside git.

Command-line build with the local OpenHarmony SDK:

```sh
cd harmony
OHOS_BASE_SDK_HOME="$HOME/Library/OpenHarmony/Sdk" \
  /Applications/DevEco-Studio.app/Contents/tools/hvigor/bin/hvigorw assembleHap \
  --mode module -p module=entry@default -p product=default
```

Native TODOs before real-device release:

- Replace `MindFSNativeBridge.download` with HarmonyOS download + system Downloads + progress/completion notification integration.
- Replace `MindFSNativeBridge.configureReplyPoller` with a real background polling task and notification tap route.
- Replace in-memory launcher node/cache storage with HarmonyOS preferences/storage.
- Replace `getAppInfo`, `openExternalURL`, and `writeClipboardText` stubs with Bundle/Want/Pasteboard Kit calls.
- Add the final HarmonyOS permissions required by the selected notification/background/download APIs.
