import datetime, hashlib, json, os, subprocess, sys, tarfile, time
from pathlib import Path

if len(sys.argv) != 3:
    sys.exit('usage: python3 -I run-model-gate.py <clean-candidate-repo> <node-bin-dir>')
repo, node_bin = Path(sys.argv[1]), sys.argv[2]
research = Path('/Users/vaiditya/dev/unmask-research')
fixtures = research / 'fixtures'
gate = research / 'product' / 'gate'
if 'GEMINI_API_KEY' not in os.environ:
    sys.exit('GEMINI_API_KEY must be present in the environment; it is never printed or written')
env = {'PATH': node_bin + ':' + os.environ['PATH'], 'UNMASK_MODEL': 'on', 'UNMASK_MODEL_QUOTA_VERIFIED': 'false', 'GEMINI_API_KEY': os.environ['GEMINI_API_KEY']}
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
run = fixtures / 'runs' / ('model-gate-' + stamp)
run.mkdir(parents=True)

def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()

def command(args, cwd):
    r = subprocess.run(args, cwd=cwd, env={'PATH': env['PATH']}, text=True, capture_output=True, timeout=180)
    if r.returncode:
        raise RuntimeError(r.stderr or r.stdout)
    return r.stdout

frozen = {'labels': (fixtures / 'labels/triage-labels.dev.v2.1.json', 'fd6ac97b52277bc6185a081f57c256e0ecfba98526518421059f177d920d16da'), 'rules': (fixtures / 'labels/SCORING_RULES.v19.txt', 'd03ac96459fea2adcf64d281b52894e43e57f1e3d99483fb2b658288d4b7454f')}
for name, (path, expected) in frozen.items():
    assert sha(path) == expected, name + ' changed after freeze'
commit = command(['git', 'rev-parse', 'HEAD'], repo).strip()
assert not command(['git', 'status', '--porcelain'], repo).strip(), 'candidate must be clean'
command(['npm', 'run', 'build'], repo)
packed = json.loads(command(['npm', 'pack', '--ignore-scripts', '--json', '--pack-destination', str(run)], repo))[0]
archive = run / packed['filename']
install = run / 'install'
install.mkdir()
(install / 'package.json').write_text('{"private":true}\n')
command(['npm', 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', str(archive)], install)
binary = install / 'node_modules/.bin/unmask'
guard = run / 'provider-only-guard.mjs'
guard.write_text("import http from 'node:http'; import https from 'node:https'; const allowed='generativelanguage.googleapis.com'; const original=globalThis.fetch; globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input.url); if(url.protocol!=='https:'||url.hostname!==allowed) throw new Error('NETWORK_FORBIDDEN '+url.hostname); return original(input,init);}; http.request=()=>{throw new Error('NETWORK_FORBIDDEN');}; https.request=()=>{throw new Error('NETWORK_FORBIDDEN');};\n")
manifest = json.loads((fixtures / 'MANIFEST.json').read_text())
selected = ['V1', 'V4', 'V5', 'V6', 'V7']
results = []
for index, item in enumerate([f for f in manifest['fixtures'] if f['id'] in selected]):
    if index:
        time.sleep(62)
    assert sha(item['variant_tarball']) == item['variant_hashes']['sha256']
    assert sha(item['source_archive']) == item['source_hashes']['sha256']
    with tarfile.open(item['source_archive'], 'r:gz') as source:
        source_root = next(m.name.split('/')[0] for m in source if m.name and m.name != '.')
    target = run / item['id']
    args = [node_bin + '/node', '--import', str(guard), str(binary), 'check', '--offline', '--allow-model', '--tarball', item['variant_tarball'], '--claim', item['claimed_identity'], '--source-archive', item['source_archive'], '--commit', item['source_commit'], '--source-root', source_root, '--source-dir', '', '--cache-dir', str(target / 'cache'), '--out', str(target / 'report')]
    started = time.monotonic()
    proc = subprocess.run(args, cwd=install, env=env, text=True, capture_output=True, timeout=300)
    report_file = target / 'report/report.json'
    report = json.loads(report_file.read_text()) if report_file.exists() else None
    model = report.get('model') if report else None
    results.append({'id': item['id'], 'exit': proc.returncode, 'seconds': round(time.monotonic() - started, 3), 'report': str(report_file), 'report_sha256': sha(report_file) if report else None, 'model_status': model.get('status') if isinstance(model, dict) else None, 'stderr_tail': proc.stderr[-2000:].replace(env['GEMINI_API_KEY'], '[REDACTED]')})
    print(json.dumps({k: results[-1][k] for k in ['id', 'exit', 'seconds', 'model_status']}), flush=True)
summary = {'tested_commit': commit, 'tarball_sha256': sha(archive), 'preregistration_sha256': sha(gate / 'PREREGISTRATION.md'), 'labels_sha256': frozen['labels'][1], 'rules_sha256': frozen['rules'][1], 'selected': selected, 'scope': 'normal installed CLI, offline local fixtures with --allow-model, provider-only network guard, default three-tier route (3.5 Flash/high, 3 Flash preview/minimal, Gemma 26B/minimal), operator caps 3/min 12000 TPM 100/day; model usefulness NOT yet scored; holdouts not opened', 'results': results}
text = json.dumps(summary, indent=2) + '\n'
assert env['GEMINI_API_KEY'] not in text
(run / 'RUN.json').write_text(text)
print(json.dumps({'record': str(run / 'RUN.json')}), flush=True)
