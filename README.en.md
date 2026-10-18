[简体中文](README.md) · [English](README.en.md)

<div align="center">
  <img src="frontend/assets/brand-mascot.png" width="100" alt="Xiao Ling, the NoReset mascot">
  <h1>NoReset · 病历不归零</h1>
  <p><strong>A local-first AI health journal for personal health records and visit preparation.</strong></p>
  <p>Voice and text conversations · Medical document organization · Traceable sources · Encrypted browser storage</p>
  <p><a href="#see-the-workflow">See the workflow</a> · <a href="#run-locally">Run locally</a> · <a href="#how-it-works">How it works</a> · <a href="https://github.com/Irixil/NoReset/issues">Feedback</a></p>
</div>

Preparing for another appointment often means telling the same story again: what changed, when it started, and which earlier records matter. NoReset helps individuals and family caregivers keep that information together, using everyday conversations and the original documents.

Describe how you feel by voice or text. Review and correct the original words, select relevant health background, and organize the information into a source-linked visit summary. The interface and current examples are primarily in Simplified Chinese.

## See the workflow

<p align="center">
  <img src="docs/readme/walkthrough.gif" width="360" alt="NoReset walkthrough: home, conversation, and source-linked visit summary">
</p>

<p align="center"><sub>Actual application screens with fictional conversation and health information.</sub></p>

## What you can do

| Your task | NoReset workflow |
| --- | --- |
| Describe changes in your health | Talk or type, add details, ask questions, and correct earlier statements. |
| Keep medical documents together | Save original photos, reports, medication packaging, and recordings; review recognized text against the original. |
| Bring relevant background | Save confirmed health background and choose up to five relevant items for a conversation. |
| Prepare for a visit | Review a summary with original statements, sources, and information to clarify. |
| Return to earlier records | Reopen conversations and search records by keyword, type, status, or date. |
| Move your records | Export an encrypted `.bingli` backup and restore it with the matching passphrase. |

## Run locally

You need **Python 3.12** and your own service credentials. The example configuration uses DeepSeek for text conversations and AIHubMix for audio transcription and image text recognition. Provider usage is billed by the corresponding service.

### 1. Get the source

```bash
git clone https://github.com/Irixil/NoReset.git
cd NoReset
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements-dev.txt
cp .env.example .env
```

<details>
<summary>Windows PowerShell environment setup</summary>

After cloning the repository, run these commands from its directory:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements-dev.txt
Copy-Item .env.example .env
```

</details>

### 2. Configure your services

Edit the local `.env` file and fill in your own keys:

```dotenv
DEEPSEEK_API_KEY=your_text_service_key
AIHUBMIX_API_KEY=your_audio_and_image_service_key
```

Keep `.env` private. See [model configuration](docs/MODEL-CONNECTION.md) for the supported provider adapters.

### 3. Start the application

```bash
python -m scripts.start_app --check-config
python -m scripts.start_dev
```

Open **[http://127.0.0.1:5173/](http://127.0.0.1:5173/)**. The frontend uses port `5173` and the backend uses port `18768`; the command starts both.

## How it works

1. **Create a local record vault.** Choose a recovery passphrase of at least ten characters and confirm it. Keep the passphrase and download backups regularly.
2. **Start a conversation.** Open “说给我听” from the home screen. Type a message or use the microphone. Add relevant background when needed and correct any misheard words.
3. **Review documents.** Save an original photo or recording, then compare the recognized text with the original, especially dates, numbers, units, and medication names.
4. **Prepare for a visit.** Open “我的记录” to review earlier conversations or select records for visit preparation. Check the original words and sources before sharing the material with a clinician.

<table>
  <tr>
    <td width="50%" align="center"><strong>Conversation and corrections</strong></td>
    <td width="50%" align="center"><strong>Visit summary with sources</strong></td>
  </tr>
  <tr>
    <td><img src="docs/readme/conversation.png" width="100%" alt="NoReset conversation with original statements and correction controls"></td>
    <td><img src="docs/readme/report.png" width="100%" alt="NoReset visit summary with source-linked statements"></td>
  </tr>
</table>

## Your data and AI services

Records and confirmed health background are encrypted in the current browser on the current device. Records do not automatically synchronize between devices. Before clearing browser data or moving devices, export an encrypted backup and keep its matching passphrase. The server cannot recover a forgotten passphrase.

Online AI features send the text needed for the current conversation, selected background, or the audio or image being recognized to the configured provider. Selected background remains attached to subsequent messages until you deselect it. The recovery passphrase is not uploaded. AI conversations, transcription, and image text recognition require network access and configured services.

NoReset is for health record keeping and communication with clinicians. Review the content against its sources. Diagnosis, treatment, and medication decisions belong with a qualified clinician.

## Explore the source

- [Architecture and project layout](docs/ARCHITECTURE.md)
- [API documentation](docs/API.md)
- [Model configuration](docs/MODEL-CONNECTION.md)
- [Detailed Chinese user guide](README.md)

## Feedback

Use [GitHub Issues](https://github.com/Irixil/NoReset/issues) for questions, suggestions, or reproducible problems. Include the steps, expected result, and actual behavior. Use fictional examples and remove personal health information, recordings, passphrases, and API keys before posting.

## License

The code currently has no general open-source license grant. Public sample materials retain their own licenses and provenance; see [sample data notes](data/public_cases/README.md).
