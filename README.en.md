[简体中文](README.md) · [English](README.en.md)

<div align="center">
  <img src="frontend/assets/brand-mascot.png" width="92" alt="Xiao Ling, the NoReset mascot">
  <h1>NoReset · 病历不归零</h1>
  <p><strong>Keep your health story going, without starting over at every appointment.</strong></p>
  <p>Voice and text conversations · Quoted follow-ups · Medical records · Encrypted local storage</p>
  <p><a href="#run-locally">Run locally</a> · <a href="#how-to-use-it">How to use it</a> · <a href="#data-and-privacy">Data and privacy</a> · <a href="https://github.com/Irixil/NoReset/issues">Feedback</a></p>
</div>

NoReset helps individuals and family caregivers record health changes through everyday conversations. Keep spoken words, documents and corrections together, then open a visit summary with links back to its sources.

Return to the same conversation tomorrow and continue. New details stay in that conversation, and its report updates as the record grows. The current interface is primarily in Simplified Chinese.

<p align="center">
  <img src="docs/readme/walkthrough.gif" width="360" alt="NoReset walkthrough: voice chat, message menu, quoted follow-up and history">
  <br><sub>Current UI with fictional text and synthetic audio. This demonstrates interaction, not model accuracy.</sub>
</p>

## What you can do

| Your task | NoReset workflow |
| --- | --- |
| Describe a health change | Type or record; an audio bubble keeps the recording, with its transcript underneath and an AI response after recognition |
| Ask about an earlier message | Long-press it and choose the first action, “追问” (follow up); ask by text or voice, or send an explanation shortcut |
| Continue days later | Open the original chat from “我的记录” (My records), with its messages, recordings and report intact |
| Correct what you just said | Edit your latest message while retaining the previous wording; clarify older messages with a new reply or quote |
| Organize documents | Upload a photo, compare the recognized text with the original, then use it in a record |
| Prepare for a visit | Review the report, missing information and original sources |
| Keep family records separate | Select the person, maintain their health background and choose relevant context for each chat |
| Manage your data | Export an encrypted backup; confirm a deletion to remove the selected local record and its linked originals |

## How to use it

### 1. Set up your local vault

On first launch, create a recovery passphrase of at least 10 characters. Select yourself or a family member before recording.

Keep the passphrase safe: it unlocks the vault and its backups. Moving to a different browser or device requires a backup import; there is no automatic synchronization.

### 2. Start a conversation

Open “和小零聊聊”, type a message, or tap the microphone. Tap “结束这句话” to finish; browsers with silence detection can also finish after a pause.

The saved recording appears as an audio bubble with a processing state. Its transcript appears below, followed by the AI response after successful recognition. No extra confirmation checkbox is required. Tap the bubble to play or pause the original audio.

If recognition fails after the original was saved, the original remains available to replay or process again. The page shows the current status.

### 3. Follow up on a specific message

Long-press your message or an AI reply; on desktop, use the context menu. “追问” is the first action. A quote appears above the input, where you can expand or cancel it.

- **解释一下 — Explain this:** immediately sends the quoted message with an explanation request.
- **详细展开 — Tell me more:** immediately sends a request for more detail about the quote.
- **Your own question:** type or record, then send.

The new question and reply appear at the bottom of the same conversation. No branch is created and earlier messages remain in place.

<p align="center">
  <img src="docs/readme/conversation.png" width="320" alt="Audio bubble and transcript">
  <img src="docs/readme/quote.png" width="320" alt="Quoted follow-up and explanation shortcuts">
</p>

### 4. Correct, save and return

Only your latest message can be edited, even after an AI reply. To clarify older wording, quote it or add a new message, preserving the meaning of later exchanges.

Records save locally. “我的记录” lists short titles and dates; opening one takes you directly back to that chat. The report is available in the upper-right corner and updates in place, retaining earlier versions and the dates of new details.

<p align="center">
  <img src="docs/readme/records.png" width="320" alt="Record titles and dates">
</p>

<p align="center">
  <img src="docs/readme/report.png" width="680" alt="Visit summary with original sources">
</p>

### 5. Add documents and make a backup

Use “看病资料” to upload document photos and compare recognized text against the originals. Select relevant documents for a chat. Confirm health background yourself before deciding whether it should be used in later conversations.

Export a `.bingli` encrypted backup in settings. To restore, select the file, enter its passphrase and follow the confirmation steps.

Deletion opens a clear confirmation dialog. Confirming removes the selected local record or conversation and its linked originals, then refreshes the lists. **Previously downloaded backups are separate files and are not deleted automatically.**

## Run locally

This repository provides source for a locally hosted application. Install **Python 3.12**. Live conversation, speech recognition and image recognition require API credentials; providers charge according to usage.

```bash
git clone https://github.com/Irixil/NoReset.git
cd NoReset
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements-dev.txt
cp .env.example .env
```

On Windows, use `py -3.12 -m venv .venv`, activate with `.venv\Scripts\Activate.ps1`, and copy `.env.example` to `.env`.

Set your credentials in the local `.env` file:

```dotenv
DEEPSEEK_API_KEY=your_conversation_api_key
AIHUBMIX_API_KEY=your_speech_and_image_api_key
```

Keep or adjust the model settings from `.env.example`, then run:

```bash
python -m scripts.start_app --check-config
python -m scripts.start_dev
```

Open **[http://127.0.0.1:5173/](http://127.0.0.1:5173/)**. The default backend port is `18768`. Recording requires browser microphone permission; remote microphone access requires a secure connection.

See [model connection instructions](docs/MODEL-CONNECTION.md) for configuration. Never commit `.env` or API keys.

## Data and privacy

- **Local storage:** conversations, health background, audio and document originals are stored in an encrypted vault in the current browser. Export a backup before clearing site data.
- **Online processing:** AI requests send the text and selected context needed for the current turn to your configured provider. Speech and image recognition send the relevant file. The recovery passphrase is not sent.
- **Traceable sources:** original words, files and correction history support review. Automatic transcription does not mean the user has verified it, and AI replies are not patient statements.
- **Communication support:** reports organize information for a visit. They do not provide diagnoses, prescriptions or treatment plans, or replace a clinician’s judgment.

## Documentation and feedback

- [Architecture and data flow](docs/ARCHITECTURE.md)
- [API documentation](docs/API.md)
- [Model connection and configuration](docs/MODEL-CONNECTION.md)
- [Report an issue or suggest a change](https://github.com/Irixil/NoReset/issues)

Describe the steps, expected result and actual result using fictional examples. Do not post real medical records, recovery passphrases or API keys in public issues.

This repository currently has no general open-source license. Public source availability does not grant unrestricted use, modification or redistribution. See [public case provenance and licenses](data/public_cases/README.md) for the sample data.
