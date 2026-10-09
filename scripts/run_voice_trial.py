"""Offline voice-trial preparation only; real execution belongs to root's server.

No Config.from_env, .env, credentials, receipt/runtime reads or real HTTP. This
module uses the current native builders with invented placeholder credentials
and intercepts the LLM opener before gate/transport. Preparation is not approval.
"""
from __future__ import annotations
import argparse
from copy import deepcopy
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import patch
import wave

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend import conversation, model_client, recognition

OUT = ROOT / 'docs/evidence/goal-audit-2026-10-09/real-voice-attempt'
TEXTS = ('完全虚构。我咳嗽两天，晚上明显。',
         '完全虚构。不是两天，是三天。咳嗽还在，别的变化我不清楚。')
ASR_MODEL = 'gemini-2.5-flash-lite'
ASR_URL = 'https://aihubmix.com/gemini/v1beta/models/gemini-2.5-flash-lite:generateContent'
LLM_MODEL = 'deepseek-flash'
LLM_URL = 'https://api.deepseek.com/chat/completions'
MAX_AUDIO_BYTES, MAX_ASR_WIRE, MAX_LLM_WIRE = 640044, 3 * 1024 * 1024, 24000

def encoded(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False).encode('utf-8')

def digest(value):
    return hashlib.sha256(value).hexdigest()

def write_frozen(path, raw):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if path.read_bytes() != raw:
            raise ValueError('frozen_artifact_changed: ' + path.name)
    else:
        with path.open('xb') as stream:
            stream.write(raw)

def save_json(path, value):
    write_frozen(path, (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n').encode('utf-8'))

def audio_info(raw):
    with wave.open(io.BytesIO(raw), 'rb') as audio:
        if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate(), audio.getcomptype()) != (1, 2, 16000, 'NONE'):
            raise ValueError('trial_requires_pcm16_mono_16000_wav')
        seconds = audio.getnframes() / 16000
        if not 0 < seconds <= 20 or len(raw) > MAX_AUDIO_BYTES:
            raise ValueError('audio_exceeds_reviewed_trial_scope')
        return {'bytes':len(raw), 'sha256':digest(raw), 'duration_seconds':seconds,
                'sample_rate':16000, 'channels':1, 'sample_width_bytes':2}

def build_fixtures(out_dir=OUT):
    """Installed macOS TTS to files, no sound device or remote voice service."""
    out_dir = Path(out_dir)
    rows = []
    for index, text in enumerate(TEXTS, 1):
        source, raw_path, final = (out_dir / f'voice{index}.txt', out_dir / f'voice{index}.tts.wav', out_dir / f'voice{index}.wav')
        write_frozen(source, (text + '\n').encode('utf-8'))
        if not final.exists():
            if raw_path.exists():
                raise ValueError('unfinished_tts_artifact_requires_review')
            subprocess.run(['/usr/bin/say','-v','Tingting','-r','155','--file-format=WAVE',
                '--data-format=LEI16@16000','-f',str(source),'-o',str(raw_path)], check=True,
                timeout=40, env={'PATH':'/usr/bin:/bin','LANG':'en_US.UTF-8'})
            with wave.open(str(raw_path), 'rb') as audio:
                if (audio.getnchannels(),audio.getsampwidth(),audio.getframerate()) != (1,2,16000):
                    raise ValueError('tts_format_unexpected')
                frames = audio.readframes(audio.getnframes())
            result = io.BytesIO()
            with wave.open(result,'wb') as audio:
                audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(16000); audio.writeframes(frames)
            write_frozen(final,result.getvalue())
        rows.append({'index':index,'reference_text':text,'filename':final.name,
            'source':'authored-synthetic-text-local-macos-tts-not-patient-or-physical-microphone',
            **audio_info(final.read_bytes())})
    save_json(out_dir/'fixtures.json',{'synthetic_only':True,'real_requests_executed':0,'audio':rows})
    return rows

def prepare_asr(audio_path, stage):
    raw = Path(audio_path).read_bytes()
    info = audio_info(raw)
    config = SimpleNamespace(name='aihubmix',url=ASR_URL,model=ASR_MODEL,api_key='invented-preview-placeholder')
    request = recognition._OpenAICompatibleProvider(config)._audio_request(raw,'audio/wav',Path(audio_path).name)
    body = json.loads(request.data)
    expected = {'temperature':0,'maxOutputTokens':1024,'thinkingConfig':{'thinkingBudget':0,'includeThoughts':False}}
    if body.get('generationConfig') != expected or len(request.data) > MAX_ASR_WIRE or request.full_url != ASR_URL:
        raise ValueError('native_asr_builder_scope_changed')
    return {'stage':stage,'synthetic_only':True,'real_requests_executed':0,'audio':info,
        'reference_text':TEXTS[int(stage[-1])-1],'wire_body':body,
        'profile':{'kind':'asr','provider':'aihubmix','model':ASR_MODEL,'url':ASR_URL,
            'source_sha256':digest(raw),'request_sha256':digest(request.data),'wire_bytes':len(request.data),
            'max_output_tokens':1024,'max_thinking_tokens':0}}

class PreviewReady(Exception): pass
class PreviewProvider:
    def complete_json(self, prompt, payload):
        self.prompt,self.payload = prompt,deepcopy(payload)
        raise PreviewReady()

def prepare_llm(native_input_path, stage):
    wrapped = json.loads(Path(native_input_path).read_text(encoding='utf-8'))
    if wrapped.get('synthetic_only') is not True or wrapped.get('stage') != stage:
        raise ValueError('only_browser_frozen_synthetic_stage_is_allowed')
    native = wrapped['native_input']
    if len(native.get('turns',[])) != int(stage[-1]):
        raise ValueError('actual_patient_turn_count_mismatch')
    preview = PreviewProvider()
    try:
        conversation.conversation_turn(deepcopy(native),provider=preview)
    except PreviewReady:
        pass
    else:
        raise ValueError('native_engine_did_not_request_model_do_not_force_call')
    captured = {}
    def freeze(request, timeout):
        captured.update(url=request.full_url,raw=request.data,profile=request._noreset_trial_profile)
        raise PreviewReady()
    client = model_client.ChatCompletionsClient(base_url='https://api.deepseek.com',model=LLM_MODEL,
        api_key='invented-preview-placeholder',json_mode=True,max_tokens=2048,
        extra_body={'thinking':{'type':'disabled'}},trial_provider='deepseek')
    with patch.object(model_client,'_open_request',freeze):
        try:
            client.complete_json(preview.prompt,preview.payload)
        except PreviewReady:
            pass
        else:
            raise ValueError('native_wire_not_frozen')
    wire = captured['raw']
    if captured['url'] != LLM_URL or len(wire) > MAX_LLM_WIRE:
        raise ValueError('native_llm_wire_exceeds_reviewed_scope')
    return {'stage':stage,'synthetic_only':True,'real_requests_executed':0,
        'native_input':native,'native_input_file_sha256':digest(Path(native_input_path).read_bytes()),
        'model_payload':preview.payload,'wire_body':json.loads(wire),
        'profile':{**captured['profile'],'url':captured['url'],'request_sha256':digest(wire),
            'wire_bytes':len(wire),'max_output_tokens':2048,'max_thinking_tokens':0}}

def write_prepared(prepared,out_dir):
    out_dir = Path(out_dir)
    save_json(out_dir/(prepared['stage']+'.prepare.json'),prepared)
    write_frozen(out_dir/(prepared['stage']+'.wire.json'),encoded(prepared['wire_body']))
    return prepared['profile']

def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prepare',action='store_true',required=True)
    parser.add_argument('--build-fixtures',action='store_true')
    parser.add_argument('--stage',choices=('asr1','asr2','llm1','llm2'))
    parser.add_argument('--native-input')
    parser.add_argument('--out-dir',default=str(OUT))
    args=parser.parse_args(argv)
    def no_network(event,args):
        if event in {'socket.connect','socket.getaddrinfo'}:
            raise RuntimeError('offline_prepare_network_forbidden')
    sys.addaudithook(no_network)
    out_dir=Path(args.out_dir)
    if args.build_fixtures: build_fixtures(out_dir)
    stages=[args.stage] if args.stage else ['asr1','asr2']
    profiles=[]
    for stage in stages:
        if stage.startswith('asr'):
            prepared=prepare_asr(out_dir/('voice'+stage[-1]+'.wav'),stage)
        else:
            if not args.native_input: parser.error('LLM preparation requires actual browser --native-input')
            prepared=prepare_llm(args.native_input,stage)
        profiles.append(write_prepared(prepared,out_dir))
    print(json.dumps({'mode':'offline-prepare-not-authorization','real_requests_executed':0,
        'profiles':profiles,'execution':'Root-controlled real Handler only; existing trial gate remains mandatory.'},ensure_ascii=False))
    return 0

if __name__=='__main__': raise SystemExit(main())
