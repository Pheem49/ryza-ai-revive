# Setup — from install to the first reply

Written for the questions in issues
[#6](https://github.com/zeroa234/ryza-ai-revive/issues/6),
[#11](https://github.com/zeroa234/ryza-ai-revive/issues/11),
[#2](https://github.com/zeroa234/ryza-ai-revive/issues/2),
[#12](https://github.com/zeroa234/ryza-ai-revive/issues/12) and
[#9](https://github.com/zeroa234/ryza-ai-revive/issues/9).

Short version: **this app has no server of its own.** It talks to two services you
choose and pay for yourself (both have free tiers), and everything else —
the avatar, the story, your save data — is local.

You need **two** things filled in:

| | What it is | Where |
|---|---|---|
| 1. LLM | the text brain that writes Ryza's lines | Settings → the first block |
| 2. TTS | the voice that reads them out | Settings → the second block |

You can skip TTS (Settings → TTS mode → off) and read the text only. You cannot
skip the LLM — without it the app has nothing to say.

---

## 1. The text model (LLM)

Fill three fields:

* **Base URL** — must be the **API root that ends in `/v1`**. The app appends
  `/chat/completions` itself. The most common mistake is pasting the website
  address (`https://openrouter.ai/`) or the full chat path
  (`https://openrouter.ai/api/v1/chat/completions`) — both fail. If your address
  is wrong you get a toast naming the base URL, not an endless spinner
  (since 1.2.22).
* **API Key** — from that provider's console. It is stored only on your device.
* **Model name** — the provider's own id. Use **Fetch model list** to pick from a
  dropdown instead of typing it.

Ready-to-use examples:

| Provider | Base URL | Notes |
|---|---|---|
| **OpenRouter** | `https://openrouter.ai/api/v1` | Free models exist; they are slower. Key: openrouter.ai/keys |
| **Ollama** (local) | `http://127.0.0.1:11434/v1` | Same machine as the app — see below. Key may be empty (1.2.23+; older builds: type anything, e.g. `ollama`) |
| **LM Studio** (local) | `http://127.0.0.1:1234/v1` | Same as above |
| OpenAI | `https://api.openai.com/v1` | Paid |
| DeepSeek | `https://api.deepseek.com/v1` | Cheap |
| Qwen (DashScope) | `https://dashscope.aliyuncs.com/compatible-mode/v1` | Has a free tier |

**Local models must run on the same device as the app.** Plain `http://` is only
accepted for loopback (`127.0.0.1`, `localhost`, `::1`); anything else must be
`https://`, so an API key never crosses a network in clear. On desktop that means
Ollama / LM Studio / llama.cpp on the same PC (allowed since 1.2.20 — issue #5).
`127.0.0.1` on a phone is the phone, so a PC on your LAN at `http://192.168.x.x`
is refused; either run the server on the phone itself, or put the PC behind an
HTTPS endpoint (a reverse proxy or tunnel) and use that `https://` URL.

A model from Hugging Face still needs a server that speaks the OpenAI chat API —
the app does not load model weights itself. Ollama can pull GGUF files straight
from Hugging Face (`ollama run hf.co/<user>/<repo>`); then use the Ollama row
above. For a loopback base URL the key may be left empty (1.2.23+).

### "I filled it in and it just says Waiting for a reply…"

Check, in this order:

1. the base URL ends in `/v1` (see above);
2. the model name matches one your provider actually serves — wrong ids are the
   second most common cause;
3. the key is a key, not a project id or an account name.

A free OpenRouter model can take 30+ seconds. The app gives up after 2 minutes
and shows the reason; before that it is genuinely still waiting.

---

## 2. The voice (TTS)

Pick a provider in the TTS block, then fill **its** fields. Each provider keeps
its own base URL and key, so switching back and forth cannot mix them up.

| Provider | What to fill |
|---|---|
| **Fish Audio** | Base URL: leave **empty** for the official API (`https://api.fish.audio`). Key: fish.audio. Model: `s2.1-pro-free` is the free engine — anything else returns 402. **Voice id may stay empty**: the API then speaks with its own default voice |
| **Qwen (DashScope)** | Key from Alibaba Cloud. Model: `qwen3-tts-flash`. A voice id is optional |
| **OpenAI** | Key + model (`gpt-4o-mini-tts`) + voice name (`alloy`, …) |
| **VOICEVOX / AivisSpeech** | Runs on your machine (desktop): start the engine, keep the default base URL, no key. The voice field is the speaker/style number |
| TTS mode → **off** | No voice at all |

Notes:

* `fishaudio.org` and `api.fish.audio` are **two different services** with the
  same name. Keys are not interchangeable. Leave the field empty unless you know
  you have a key for the older `fishaudio.org` surface.
* **ASMR mode** (the pill at the top of the chat screen: 雑談 / 物語 / 没入 /
  **ASMR** / テキスト) whispers — slower, quieter, closer. It uses its own voice
  id in the Fish block (`fish_voice_asmr`) if you set one, otherwise the normal
  voice. This is what issue #12 was asking about: it is a *talk mode*, not a
  costume.
* Speech **input** is separate (Settings → speech input): either the phone's own
  recogniser or an OpenAI-compatible `/audio/transcriptions` endpoint.

---

## 3. Install

**Android** — download `RyzaChat-<version>.apk` from
[Releases](https://github.com/zeroa234/ryza-ai-revive/releases) and open it. The
app asks for the microphone only, and only when you first use speech input; the
file picker for outfit import uses the system's per-file grant, so no storage
permission is requested.

**Windows** — download and run `RyzaChat-Setup-<version>.exe`. Your data lives in
`%AppData%\RyzaChat` and is kept when you uninstall (delete it from
Settings → data if you want it gone).

**From source** — see the README. The avatar/animation binaries are not in git;
after cloning, restore them or the character will not render:

```powershell
python scripts/restore_media.py path/to/RyzaChat-<version>.apk
```

---

## 4. Your data, and the save slots

Settings → **Character profile** → **Save slots** (bottom of the page) gives you
three slots. *Save here* writes the whole picture — settings, chat history,
memory, RPG state, day, outfit — and *Load* puts it back. Loading is refused on an
empty or damaged slot, with a message saying so.

> If you are on **1.2.19 – 1.2.21**: the save buttons were broken in those three
> releases. They wrote nothing and still said "Saved" (issue #6 — the storage key
> was left behind when the settings screen was split out of `app.js`). Fixed in
> 1.2.22. Nothing was lost — there was never anything to lose — but you do need
> the newer build.

Everything else is saved continuously as you type, so closing the app does not
lose it. Two things worth knowing:

* Data lives in the app's own storage. On Android that is the app's data
  directory; if you clear the app's data or uninstall it, it goes with it.
* A slot carries your chat history, so a very long conversation can hit the
  device's storage quota. The app says so instead of silently failing.

---

## 5. Costumes, ASMR and the undress toggle

* **Costumes**: 6 outfits ship in the release and all of them can be worn
  (Settings → Outfits). You can also import your own ZIP.
* **Sitting / standing**: the chip appears for outfits that ship both skeletons
  (official 0001 does). A stage change returns to standing.
* **undress** (Settings → the NSFW switch, off by default): when it is on, the
  model can ask for the alternate texture. If an outfit has no such texture — or
  the animation binaries were never restored in a source checkout — the app now
  tells you which of the two it is instead of leaving a 404 in a console you
  cannot see (issue #4).

---

## 6. Still stuck?

Open an issue with: the platform (APK / exe / browser), the version from
Settings, **the provider and base URL you typed** (never your key), and the exact
toast or error line. A screenshot of the Settings screen is the fastest way.

---

## Bahasa Indonesia (ringkas)

Butuh **dua** layanan, keduanya milikmu sendiri:

1. **LLM** (otak teks) — isi **Base URL** (harus berakhiran `/v1`), **API Key**,
   dan **nama model**. Contoh gratis: OpenRouter `https://openrouter.ai/api/v1`.
   Kalau isinya bukan `/v1`, aplikasi akan memberi pesan yang menyebut Base URL —
   bukan berputar tanpa akhir.
2. **TTS** (suara) — pilih provider lalu isi kolomnya. Fish Audio: biarkan Base
   URL **kosong**, key dari fish.audio, model `s2.1-pro-free`; id suara boleh
   kosong (API punya suara bawaan). Qwen: model `qwen3-tts-flash`.

Model lokal (Ollama) hanya bisa di desktop — di HP, `127.0.0.1` berarti HP itu
sendiri.

**Slot simpan** ada di Pengaturan → Karakter → paling bawah. Di versi
**1.2.19–1.2.21 tombol simpan rusak** (tidak menyimpan apa pun tapi tetap
mengatakan "Tersimpan"): pakai 1.2.22 atau lebih baru.

**ASMR** adalah mode percakapan (pil di atas layar chat), bukan kostum.
**undress** ada di Pengaturan dan mati secara bawaan; kalau kostumnya tidak punya
tekstur itu, aplikasi sekarang memberi tahu.
