"""Build local, authored test media. No provider, credentials or network access."""
from __future__ import annotations
import hashlib
import json
import subprocess
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SOURCE = Path(__file__).parent
OUT = ROOT / 'docs/evidence/goal-audit-2026-10-08/preflight'
ASR_TEXT = '以下内容完全虚构。我咳嗽两天了，晚上明显，想整理给医生看。'
OCR_LINES = [
    '完全虚构 · 合成测试资料',
    '姓名：合成人甲',
    '记录日期：2026年10月8日',
    '来源：虚构家庭记录',
    '本人描述：咳嗽两天，晚上更明显。',
    '这张资料由测试人员原创，不是患者文件。',
]


def main():
    from PIL import Image, ImageDraw, ImageFont
    OUT.mkdir(parents=True, exist_ok=True)
    (SOURCE / 'asr-source.txt').write_text(ASR_TEXT, encoding='utf-8')
    (SOURCE / 'ocr-source.txt').write_text('\n'.join(OCR_LINES) + '\n', encoding='utf-8')
    voice = OUT / 'voice.wav'
    existing_audio = False
    if voice.is_file():
        with wave.open(str(voice), 'rb') as audio:
            existing_audio = audio.getnframes() > 0
    if not existing_audio:
        subprocess.run(['say', '-v', 'Tingting', '-r', '155', '--file-format=WAVE',
                        '--data-format=LEI16@16000', '-f', str(SOURCE / 'asr-source.txt'),
                        '-o', str(voice)], check=True)
    with wave.open(str(voice), 'rb') as audio:
        seconds = audio.getnframes() / audio.getframerate()
        assert 0 < seconds <= 20 and voice.stat().st_size <= 2 * 1024 * 1024
        audio_info = {'duration_seconds': seconds, 'sample_rate': audio.getframerate(),
                      'channels': audio.getnchannels()}
    image = Image.new('RGB', (1200, 800), 'white')
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Songti.ttc', 36)
    for index, line in enumerate(OCR_LINES):
        draw.text((60, 65 + index * 95), line, fill='#202020', font=font)
    card = OUT / 'card.png'
    image.save(card)
    assert card.stat().st_size <= 2 * 1024 * 1024
    media = []
    for path, info in ((voice, audio_info), (card, {'width': 1200, 'height': 800})):
        media.append({'path': str(path.relative_to(ROOT)), 'bytes': path.stat().st_size,
                      'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), **info})
    packet = {
        'schema_version': 'noreset-five-call-inputs-v1',
        'synthetic_only': True, 'approved': False, 'real_requests_executed': 0,
        'reference_time': '2026-10-08T12:00:00Z',
        'source': 'Authored solely for this local test; no patient or benchmark material.',
        'media': media,
        'calls': [
            {'number': 1, 'kind': 'asr', 'source_file': media[0]['path'],
             'expected_text_for_human_comparison': ASR_TEXT},
            {'number': 2, 'kind': 'llm', 'purpose': '回应已人工对照的合成转写',
             'depends_on': 1, 'current_turn': ASR_TEXT},
            {'number': 3, 'kind': 'llm', 'purpose': '回应当前担忧/纠正',
             'current_turn': '以下内容完全虚构。刚才说错了，不是两天，是三天。我担心把时间讲错，能先帮我把原话记清楚吗？'},
            {'number': 4, 'kind': 'ocr', 'source_file': media[1]['path'],
             'expected_text_for_human_comparison': '\n'.join(OCR_LINES)},
            {'number': 5, 'kind': 'llm', 'purpose': '人工对照原图后整理已选必要资料',
             'depends_on': 4, 'source_review_required': True,
             'source_kind': 'document', 'human_comparison_pending': True},
        ],
        'activation': 'This input packet is not an authorization receipt. Actual provider bodies and their hashes must be reviewed before explicit budget authorization. Unknown recognition output may not silently continue.',
        'manual_review': ['原音/原图逐项对照', '切题与纠正回应', '报告来源与版本', '临床问诊和风险规则由专业人员审阅'],
    }
    (OUT / 'five-call-inputs.json').write_text(json.dumps(packet, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'media': media, 'approved': False, 'real_requests_executed': 0}, ensure_ascii=False))


if __name__ == '__main__':
    main()
