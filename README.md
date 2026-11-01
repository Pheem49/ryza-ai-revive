# Ryza AI Revive (Ryza Chat)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Release: 1.2.23](https://img.shields.io/badge/Release-1.2.23-orange.svg)](https://github.com/zeroa234/ryza-ai-revive/releases)
[![Platform](https://img.shields.io/badge/Platform-Web%20%7C%20Windows%20%7C%20Android-blue.svg)](#multi-platform-support)

A local-first, interactive conversational companion application featuring a real-time animated 2D Spine avatar of **Reisalin "Ryza" Stout** (*Atelier Ryza* series). Built with a static HTML/JavaScript client kernel, rich companion RPG mechanics, real-time voice synthesis, and multi-platform packaging for Web, Desktop (Electron), and Android (WebView).

---

## Table of Contents

- [Overview](#overview)
- [What's New in v1.2.23](#whats-new-in-v1223)
- [Key Features](#key-features)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Setup & Configuration](#setup--configuration)
  - [1. Large Media Assets Restoration](#1-large-media-assets-restoration)
  - [2. Language Model (LLM) Setup](#2-language-model-llm-setup)
  - [3. Voice Synthesis (TTS) Setup](#3-voice-synthesis-tts-setup)
  - [4. Speech Input (STT) Setup](#4-speech-input-stt-setup)
- [Building for Platforms](#building-for-platforms)
- [Testing & Quality Assurance](#testing--quality-assurance)
- [Project Structure](#project-structure)
- [Troubleshooting & FAQ](#troubleshooting--faq)
- [Disclaimer & License](#disclaimer--license)

---

## Overview

Ryza AI Revive is an offline reconstruction client designed to run entirely locally without dependencies on centralized servers. Your conversations, memories, save data, and game state stay securely on your own device.

Intelligence and speech are attached dynamically at runtime via standard HTTP APIs configured directly by the user:
- Connects to any **OpenAI-compatible LLM endpoint** (e.g., OpenRouter, OpenAI, DeepSeek, Qwen/DashScope, or local models via Ollama and LM Studio).
- Supports modern **Text-to-Speech (TTS)** engines (Fish Audio, Alibaba Qwen/CosyVoice, OpenAI TTS, or local VOICEVOX/AivisSpeech).

---

## What's New in v1.2.23

This release integrates all upstream updates from **v1.2.23 (Code 26)** while fully preserving our custom community enhancements:

1. **Cross-legged Sitting Posture (盤 / `btn-sit-variant`)**: Outfits supporting dual sitting poses (`sitting_normal` / `sitting_agura`) now feature a dedicated 「盤」 HUD button to switch between regular seated and cross-legged poses with fully synchronized leg and arm animations.
2. **Deterministic Rest & Sleep (`stamina.sleep`)**: Adventure Status sheet now features a "Go Home and Sleep" button that recovers full stamina and advances the clock without waiting for LLM `<state>` triggers (gated to evening/night when stamina is not full).
3. **Local LLM Zero-Key Support (`Config.llmReady`)**: Loopback endpoints (`127.0.0.1` / `localhost` for Ollama, LM Studio, vLLM) no longer require a dummy API key.
4. **Automatic Gather Quest Progress**: Gathering items into your inventory (`inventory_added`) advances gather quests automatically without requiring redundant quest blocks from the LLM.
5. **Memory Protection & Recovery**: Rotary `.bak` backups on write, unreadable files quarantined as `.corrupt` instead of discarded, and full memory log display without the previous 40-item truncation.
6. **Long-term Memory in Save Slots**: Save slots 1–3 now serialize long-term memories and digests alongside game state and conversation history.
7. **Storage Pressure Canary**: Proactive storage health monitoring warns via toast (`toast.storageFull`) when `localStorage` quota is nearing capacity.
8. **Automatic Device Language Detection**: Fresh launches detect system language via `navigator.languages` (zh, zh-tw, ja, id, en) automatically.
9. **Desktop Navigation & Sheet Closers**: Full keyboard `Esc` dismiss and dedicated close (`×`) handles on all bottom sheets for desktop and browser users.
10. **Custom Persona Override (`chara.override`)**: Direct configuration field in Character Settings to inject custom persona instructions and system prompt extensions.
11. **Skin Verification Tool (`scripts/verify_skins.py`)**: Official script to validate custom ZIP skin archives against Spine 4.2 runtime specifications.

---

## Key Features

### 🌟 Real-time 2D Spine Avatar
- **Spine 4.2 WebGL Engine**: Smooth portrait rendering, physics-driven secondary motion, and dynamic lighting.
- **Emotion & Expression System**: Live facial expression transitions responding to conversational sentiment (happy, thinking, blushing, surprised, sleepy, and more).
- **Interactive Hit Testing**: Tap head, chest, hands, or accessories for animated physical reactions and voiced remarks.
- **Posture & Camera Control**: Seamless switching between standing and sitting postures, player zoom/panning controls, and focus modes.
- **Outfits & Costumes**: Ships with 6 official costumes (including Summer Adventure and classic alchemist outfits) plus support for custom user outfit ZIP packages and optional customizable textures.

### 💬 Multi-Mode Dialogue System
Switch conversational modes on the fly via the top mode selector:
- **Chat (Casual)**: Everyday banter, alchemy tips, and friendly conversation.
- **Story (Adventure)**: Interactive quest-driven storylines, scenario choices, and world exploration.
- **Immersive (Roleplay)**: Deep in-character immersion in Kurken Island and secret hideout settings.
- **ASMR (Whisper)**: Soft whisper delivery, reduced pace, intimate acoustic shaping, and dedicated whisper voice models.
- **Text (Silent)**: Instant visual dialogue cards without voice output.

### 🎮 Companion RPG Mini-Systems
- **World Map Exploration**: Explore Kurken Island, the Sunken City, Hidden Cove, and the Underworld with interactive pins, time-of-day cycles, and weather conditions.
- **Stamina & Rest System**: Stamina points consumed during activities and restored through apples or night-time rest.
- **Quest Chains**: Multi-phase alchemical and adventure missions with progression tracking and rewards.
- **Daily Login Rewards**: Day-counter tracking, streak bonuses, and interactive reward claim events.
- **Inventory & Memories**: Alchemical ingredient bag, item usage, adventure logs, and episodic memory snapshots.
- **Alarm Clock**: Native schedule integration with custom voice callouts and wake-up greetings.

### 🌐 Comprehensive Multilingual Support (i18n)
- **7 Complete UI Locales**: English (`en`), Japanese (`ja`), Thai (`th`), Traditional Chinese (`zh-TW`), Simplified Chinese (`zh-CN`), Korean (`ko`), and Indonesian (`id`).
- **4 Independent Language Slots**:
  1. *UI Language*: Interface labels, menus, and system dialogs.
  2. *Bundled Voice Pack*: Built-in voice clips and character voice prompts.
  3. *LLM Output Language*: Language requested from the reasoning model.
  4. *TTS Speech Language*: Synthesizer pronunciation and phonetic mapping (supports real-time translation when LLM and TTS languages differ).

### 🔒 Local-First & Privacy-Focused
- No telemetries, no tracking, and no external calls other than the specific API endpoints you explicitly define.
- All chats, settings, and game progress are stored in `localStorage` (or `%AppData%\RyzaChat` on Desktop).
- 3 dedicated local save slots with export/backup support.

---

## Architecture

The project maintains a shared client runtime loaded identically across three host environments:

| Component | Path | Description |
|---|---|---|
| **Shared Web Client** | `web/` | Vanilla HTML5 / ES6 JavaScript / CSS3 kernel (no bundler required). Spine WebGL renderer, state reducers, and localization. |
| **Desktop Host** | `desktop/` | Frameless Electron shell with transparent HUD strip, window controls, draggable headers, and pin-on-top mode. |
| **Android Host** | `android/` | Lightweight Android wrapper with native WebView, hardware acceleration, and embedded local `AssetServer`. |
| **Tooling & Scripts** | `scripts/` | Local development server with CORS proxy, media restorers, index builders, and headless test suites. |
| **Configuration** | `config/` | Version manifest (`version.json`), layer contracts (`layers.json`), and provider templates. |

### The CORS Proxy Contract (`/_proxy`)
Because browsers and mobile WebViews enforce strict Cross-Origin Resource Sharing (CORS) rules that would block third-party API calls, all three hosts implement an identical transparent reverse proxy contract:
- Development server: `scripts/serve.py` proxies `/_proxy` requests.
- Desktop Electron: The custom protocol handler intercepts and proxies network requests.
- Android: Local `AssetServer` handles network dispatching without CORS restrictions.

---

## Quick Start

### Prerequisites
- **Python 3.10+**
- **Node.js 18+**

### 1. Clone the Repository
```bash
git clone https://github.com/zeroa234/ryza-ai-revive.git
cd ryza-ai-revive
```

### 2. Restore Binary Media Assets
Large binary files (Spine skeleton binaries `.skel`, high-resolution textures `.png`, and voice audio files `.mp3`/`.wav`) are excluded from git to maintain a compact repository size.

Restore them from any existing official APK release or unpacked desktop build:
```bash
# If using an APK release:
python3 scripts/restore_media.py path/to/RyzaChat-1.2.23.apk

# If using an unpacked Windows desktop folder:
python3 scripts/restore_media.py path/to/win-unpacked/resources/web
```

### 3. Launch Development Server
```bash
npm start
# or: python3 scripts/serve.py
```
Open **`http://127.0.0.1:8765/`** in your browser.

> **Important**: Always launch using `python3 scripts/serve.py` (or `npm start`). Do **not** use `python3 -m http.server`, as plain HTTP servers do not provide the `/_proxy` endpoint required for LLM and TTS requests.

---

## Setup & Configuration

Configure your AI providers via the in-app **Settings** menu (click the pencil/edit icon on the top right or open the left navigation drawer).

### 1. Language Model (LLM) Setup
Fill in the top configuration block:

| Setting | Requirements & Examples | Notes |
|---|---|---|
| **Base URL** | Must end in `/v1`. <br>Example: `https://openrouter.ai/api/v1` | **Do not** append `/chat/completions` (the app appends this automatically). |
| **API Key** | Your provider's API key | Stored strictly in local device storage. |
| **Model Name** | e.g., `openai/gpt-4o-mini`, `deepseek-chat`, `qwen-plus` | Click **Fetch model list** to query your provider and select from a dropdown. |

#### Popular Providers:
- **OpenRouter** (`https://openrouter.ai/api/v1`): Broad model selection with affordable and free tiers.
- **DeepSeek** (`https://api.deepseek.com/v1`): High reasoning capability at low cost.
- **Local Ollama (Desktop only)** (`http://127.0.0.1:11434/v1`): 100% offline local inference (enter any placeholder API key like `ollama`).
- **Local LM Studio (Desktop only)** (`http://127.0.0.1:1234/v1`): Run local quantized GGUF models on desktop.
- **Alibaba Qwen / DashScope** (`https://dashscope.aliyuncs.com/compatible-mode/v1`).
- **Official OpenAI** (`https://api.openai.com/v1`).

### 2. Voice Synthesis (TTS) Setup
Choose your preferred speech engine in the TTS settings:

| Engine | Setup Instructions |
|---|---|
| **Fish Audio** | Leave Base URL **empty** for the official endpoint (`https://api.fish.audio`). Enter your key from `fish.audio`. Free model: `s2.1-pro-free`. Voice ID is optional. |
| **Qwen (DashScope)** | Enter DashScope API key. Model: `qwen3-tts-flash`. Voice ID is optional. |
| **OpenAI TTS** | Enter OpenAI API key, select model (`tts-1` or `gpt-4o-mini-tts`), and voice (`alloy`, `nova`, `shimmer`, etc.). |
| **VOICEVOX / AivisSpeech** | Runs locally on Desktop: start engine, use default base URL, set voice ID to desired speaker/style number. |
| **Off** | Disables speech synthesis; displays dialogue in text bubbles only. |

### 3. Speech Input (STT) Setup
The microphone button allows voice dictation:
- **Browser Recognizer**: Built-in streaming Web Speech API (zero configuration).
- **Server-side Whisper**: Enter an OpenAI-compatible `/audio/transcriptions` base URL and API key.

---

---

## Capabilities

- Dialogue modes: chat, story, immersive, ASMR, text
- Spine 4.2 portrait and scene graph (posture, camera, tap hit-testing)
- Local RPG-style state: stamina, quests, inventory, daily rewards (`localStorage`)
- Two-layer session memory plus a dated long-term layer, independent of adventure logs
- Sitting variants (normal / cross-legged) when the worn outfit ships both
- Deterministic sleep / rest at home (`stamina.sleep`)
- Storage-pressure canary: a full origin is reported instead of failing silently
- Four language slots (UI, bundled voice, LLM output, TTS), seven UI locales
- Tagged replies for scene side effects; numeric deltas in a trailing `<state>` block (no function-calling requirement)

---

## Runtime Resources

Structural tables (JSON, atlas, SVG) live in `web/assets/` and are versioned with the client. Large binaries (raster, audio, skeleton) are excluded from version control and restored before a full session or packaged build:

```bash
python scripts/restore_media.py path/to/RyzaChat-1.2.23.apk
python scripts/restore_media.py path/to/win-unpacked/resources/web
```

---

## Building for Platforms

### Desktop (Electron Application)
Run the desktop app directly:
```bash
cd desktop
npm install
npm start
```

Build the self-contained Windows NSIS installer (`.exe`):
```powershell
powershell -File scripts/build_desktop.ps1
```

### Android (APK Package)
Setup the Android command-line tools and JDK (one-time setup):
```powershell
powershell -File scripts/setup_android_tools.ps1
```

Compile the debug/release APK:
```powershell
powershell -File scripts/build_apk.ps1
```

---

## Testing & Quality Assurance

The codebase includes an extensive suite of automated tests and architectural constraints (the full list of suites lives in [docs/PROJECT.md §4](docs/PROJECT.md)):

```bash
# Run core test suite (boot smoke test + strict layer verification)
npm test

# Run individual regression suites
node scripts/boot_smoke.js                  # Verifies headless bootstrap and state machine
node scripts/layering_check.js --strict     # Enforces strict module boundaries and zero cycles
node scripts/game_logic_regression.js       # Verifies RPG reducers, items, quests, stamina
node scripts/memory_regression.js           # Verifies long-term episodic memory cards
node scripts/motion_regression.js           # Verifies Spine animations, transitions, and postures
node scripts/sitting_regression.js          # Verifies sitting posture variants and arm/leg animations
node scripts/save_slot_regression.js        # Verifies 3-slot save/load serialization
node scripts/back_regression.js             # Verifies Android/desktop back button navigation stack
node scripts/transport_error_regression.js  # Verifies network timeouts and HTTP error handling
node scripts/i18n_coverage.js               # Verifies complete 7-locale translation coverage
python3 scripts/privacy_check.py web        # Packaging gate: checks for accidentally leaked secrets
```

---

## Project Structure

```
├── web/                           # Shared client web kernel (no build step needed)
│   ├── index.html                 # Main HUD layout, views, and modal sheets
│   ├── css/                       # Theme styles, animations, responsive design
│   │   ├── app.css                # Atelier Ryza warm-gold visual design system
│   │   └── spine-player.css       # Avatar canvas positioning
│   ├── js/                        # Modular client architecture
│   │   ├── app.js                 # App coordinator and port wiring
│   │   ├── avatar.js              # Spine 4.2 WebGL controller & hit testing
│   │   ├── api.js                 # LLM, TTS, STT transports and parsing
│   │   ├── game.js                # Alchemical RPG state reducer
│   │   ├── quests.js              # Quest engine and progression
│   │   ├── daily.js               # Daily reward bonuses
│   │   ├── world.js               # Kurken Island map coordinates and pins
│   │   ├── memory.js              # Companion memory store
│   │   ├── i18n.js                # 7-locale translation tables
│   │   └── settings.js            # Configuration UI manager
│   ├── assets/                    # Game tables, icons, and restored media
│   └── vendor/                    # Spine 4.2 WebGL runtime
├── desktop/                       # Electron desktop wrapper
│   ├── main.js                    # Frameless window, system tray, proxy interceptor
│   └── package.json
├── android/                       # Native Android application
│   ├── app/src/main/              # WebView activity and embedded AssetServer
│   └── build.gradle
├── scripts/                       # Development, packaging, and test scripts
│   ├── serve.py                   # Local dev server with CORS reverse proxy
│   ├── restore_media.py           # Asset unpacker from APK or desktop builds
│   ├── build_indexes.py           # Asset index generator
│   ├── build_desktop.ps1          # Windows installer builder
│   └── build_apk.ps1              # Android APK builder
├── config/                        # Manifests and templates
│   ├── version.json               # Single source of truth for version numbering
│   ├── layers.json                # Architectural module boundaries
│   └── providers.example.json     # Configuration hydration template
├── docs/                          # In-depth architectural and setup documentation
│   ├── PROJECT.md                 # Detailed module boundary specifications
│   └── SETUP.md                   # Extended user onboarding and setup troubleshooting
└── README.md
```

---

## Troubleshooting & FAQ

#### 1. The avatar is completely invisible or shows a black screen.
- **Cause**: Binary Spine assets (`.skel`, `.atlas`, `.png`) have not been restored from an APK or build yet.
- **Solution**: Run `python3 scripts/restore_media.py path/to/RyzaChat-1.2.23.apk`.

#### 2. The app is stuck on "Waiting for a reply...".
- Check that your **Base URL ends in `/v1`** (e.g., `https://openrouter.ai/api/v1`).
- Verify that your **Model identifier** matches the provider's active catalog (use the **Fetch model list** button).
- Check that your **API key** is valid and has sufficient account balance.
- Free models on OpenRouter may take up to 30-45 seconds during high traffic; the client automatically times out after 120 seconds if the host fails to respond.

#### 3. Can I use local Ollama models on Android?
- **No**. On mobile devices, `127.0.0.1` refers to the phone itself. To use a local desktop Ollama instance from your phone, enter your computer's LAN IP address (e.g., `http://192.168.1.100:11434/v1`) and ensure Ollama is configured with `OLLAMA_HOST=0.0.0.0`.

#### 4. Where is my save data kept?
- **Web Browser**: Browser `localStorage`.
- **Desktop**: `%AppData%\RyzaChat` (Windows) or `~/.config/RyzaChat` (Linux).
- **Android**: Android app internal storage directory.
- You can export and restore snapshots anytime via **Settings → Character profile → Save slots**.

---

## Disclaimer & License

- **Disclaimer**: This is a non-commercial, fan-made offline reconstruction project. All intellectual property, characters, voice recordings, artwork, and trademarks related to *Atelier Ryza* and *Reisalin Stout* belong to **KOEI TECMO GAMES CO., LTD.** and **Gust Co. Ltd.**
- **Code License**: The client code, proxy architecture, and toolchain in this repository are licensed under the [MIT License](LICENSE).
