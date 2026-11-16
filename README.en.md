# dsh-voice-prompt-enhancer

A DeepSeek Harness (DSH) plugin: **prompt optimization** + **voice input enhancement** — rewrites a composer draft into something clearer and more actionable, and adds a hotkey, stop-on-silence, filler removal and correction to voice input.

A draft is often half a requirement, so the model asks again — click ✨ and it is rewritten in place, undoable. With voice, just speak; it stops on a pause and the transcript lands back in the composer.

[![Release](https://img.shields.io/github/v/release/Fishsb/dsh-voice-prompt-enhancer)](https://github.com/Fishsb/dsh-voice-prompt-enhancer/releases) [![Stars](https://img.shields.io/github/stars/Fishsb/dsh-voice-prompt-enhancer)](https://github.com/Fishsb/dsh-voice-prompt-enhancer/stargazers) [![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE) [![DSH](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FFishsb%2Fdsh-voice-prompt-enhancer%2Fmain%2Fpackage.json&query=%24.peerDependencies%5B%27%40deepseek-ai%2Fdsh-client-locale%27%5D&label=DSH&color=blue)](docs/compatibility-matrix.md)

## Install

```sh
dsh plugin --profile web add dsh-voice-prompt-enhancer
dsh plugin --profile web update dsh-voice-prompt-enhancer   # update
dsh plugin --profile web remove dsh-voice-prompt-enhancer   # remove
```

Or install a specific tag from GitHub:

```sh
dsh plugin --profile web add github:Fishsb/dsh-voice-prompt-enhancer#v3.5.1
```

Restart DSH afterwards (also after updating or removing) — the ✨ button appears in the composer toolbar. Requires [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) **≥ 0.2.1-rc.1** installed locally and `pnpm` in PATH.

## What it does

**Prompt optimization**

- ✨ **One-click optimize** — rewrite the current draft; keep refining, undo, or cancel while optimizing
- **5 modes** — Basic / Lite / Standard / Expert / One-click Publish
- **Memory switch** — pre-send rounds accumulate into a memory chain, cleared on send (off by default)
- **Model chain** — try models in order, add/remove/reorder, toggle thinking, test connectivity inline

**Voice input enhancement** (transcription is provided by DSH's official `speechToText`; the plugin ships no engine and downloads no models)

- **Two entry points** — the official 🎤 button (click to start / click to stop), or the plugin hotkey (tap to start / tap to stop; long-press = hold to talk, release to stop)
  ⚠️ Long-press applies to the **plugin hotkey** only; the official button only responds to clicks (enable and record a hotkey in plugin settings first)
- **Stop on silence** — auto-stop with a configurable 1-5 s silence window (default 2 s), can be turned off entirely
- **Filler removal** — local rule-based cleanup of filler words / repeats / trailing isolated pauses; no rewriting, no additions (on by default)
  (Note: the previous "drawn-out sounds" wording overstated it — there is no elongation-compression rule; corrected 2026-11-17)
- **Transcript correction** — word-level fixes after transcription, voice path only (off by default)
- **Auto-enhance** — trigger enhancement automatically once the transcript is in the draft (off by default)

Buttons and text follow the DSH interface language (中文 / English).

## Settings at a glance

Settings → "Prompt Enhancer"; changes save immediately:

| Where | What |
|---|---|
| Model chain | Model chain; Voice input: hotkey, stop-on-silence (1-5 s), filler removal, transcript correction (configurable 1-3 rounds), auto-enhance level, ambient-noise measurement, learning dictionary |
| Optimization | Mode, template, memory switch, context budget, timeout / reply length / output limit |

Capture, transcription and writing back are all handled by DSH's official voice control — the plugin only adds the value-adds above. Audio is not written to disk.

![Voice input](docs/screenshots/voice-main.png)

[Releases](https://github.com/Fishsb/dsh-voice-prompt-enhancer/releases) · [CHANGELOG](CHANGELOG.md) · [Compatibility notes](docs/compatibility-matrix.md) · Licensed under [Apache-2.0](LICENSE)

> Privacy: the plugin records and reports nothing. However, the following text is sent to **the external LLM you configured**: the prompt-enhancement draft (plus workspace/session excerpts injected per budget), and — during voice correction — the draft together with the last 1-3 conversation rounds (configurable). Verify before sending.
