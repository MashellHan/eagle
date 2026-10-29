from pathlib import Path
import hashlib, json, os, subprocess, sys, tempfile, time, uuid

source_path = Path(sys.argv[1])
label = sys.argv[2]
root = Path(tempfile.mkdtemp(prefix='eagle-keychain-regression-' + label + '-'))
source = source_path.read_bytes()
source_hash = hashlib.sha256(source).hexdigest()
(root / 'Entry.original.swift').write_bytes(source)
barrier = '''
    if let dir = ProcessInfo.processInfo.environment["EAGLE_FIXTURE_BARRIER"] {
      let ready = URL(fileURLWithPath: dir).appendingPathComponent("ready")
      try Data("ready".utf8).write(to: ready)
      let proceed = URL(fileURLWithPath: dir).appendingPathComponent("proceed")
      let until = Date().addingTimeInterval(10)
      while !FileManager.default.fileExists(atPath: proceed.path) {
        guard Date() < until else { throw Refused.invalid }
        Thread.sleep(forTimeInterval: 0.01)
      }
    }
'''
code = source.decode()
assert '    let existing = try read()' in code
assert '    guard try read() != nil else { return }' in code
instrumented = code.replace('    let existing = try read()', '    let existing = try read()' + barrier)
instrumented = instrumented.replace('    guard try read() != nil else { return }', '    guard try read() != nil else { return }' + barrier)
(root / 'Entry.swift').write_text(instrumented)
binary = root / 'helper'
subprocess.run(['xcrun', 'swiftc', '-swift-version', '5', '-sdk',
  (os.environ.get('EAGLE_TEST_SDK') or ('/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk' if Path('/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk').exists() else subprocess.check_output(['xcrun', '--show-sdk-path'], text=True).strip())), '-parse-as-library',
  str(root / 'Entry.swift'), '-o', str(binary)], check=True)
binding = {'namespace': hashlib.sha256(str(root).encode()).hexdigest(),
  'botId': 'regression-fixture-' + str(uuid.uuid4()), 'credentialRef': str(uuid.uuid4()),
  'origin': 'https://origin-a.example.test'}
other = {**binding, 'origin': 'https://origin-b.example.test'}
secret_a = 'fixture-owner-a-' + str(uuid.uuid4())
secret_b = 'fixture-owner-b-' + str(uuid.uuid4())
secret_stale = 'fixture-owner-stale-' + str(uuid.uuid4())
env = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin'}
def invoke(action, target, values=None):
  payload = {'action': action, 'binding': target, **(values or {})}
  return subprocess.run([str(binary)], input=json.dumps(payload), text=True,
    capture_output=True, timeout=15, env=env)

log_path = root / 'evidence.jsonl'
failures = 0
with log_path.open('w') as log:
  def report(check, **value):
    log.write(json.dumps({'check': check, **value}) + '\n'); log.flush()
  report('fixture', root=str(root), sourceHash=source_hash,
    timingBarrierOnly=True, sameExecutableForAllKeychainCalls=True)
  cleanup_bindings = [binding, other]
  racer = None
  try:
    for action in ['put', 'remove']:
      state = root / action; state.mkdir()
      assert invoke('put', binding, {'ownerToken': secret_a}).returncode == 0, 'initial fixture put'
      payload = {'action': action, 'binding': binding}
      if action == 'put': payload['ownerToken'] = secret_stale
      racer = subprocess.Popen([str(binary)], env={**env, 'EAGLE_FIXTURE_BARRIER': str(state)},
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
      racer.stdin.write(json.dumps(payload)); racer.stdin.close()
      until = time.monotonic() + 10
      while not (state / 'ready').exists():
        assert racer.poll() is None, 'racer failed before timing barrier'
        assert time.monotonic() < until, 'racer barrier timeout'
        time.sleep(.01)
      assert invoke('remove', binding).returncode == 0, 'old binding removal'
      assert invoke('put', other, {'ownerToken': secret_b}).returncode == 0, 'replacement binding put'
      (state / 'proceed').write_text('go')
      racer.wait(timeout=15)
      read = invoke('read', other)
      preserved = read.returncode == 0 and json.loads(read.stdout).get('ownerToken') == secret_b
      rejected = racer.returncode != 0
      failures += int(not preserved) + int(not rejected)
      report(action + ' race', staleOperationRejected=rejected, replacementBindingPreserved=preserved,
        expectedBothTrue=True)
      invoke('remove', binding); invoke('remove', other)
      assert invoke('read', binding).returncode == 1 and invoke('read', other).returncode == 1, 'race fixture cleanup'

    cases = [
      ('namespace LF', {'namespace': binding['namespace'] + '\n'}, {'ownerToken': secret_a}),
      ('namespace CRLF', {'namespace': binding['namespace'] + '\r\n'}, {'ownerToken': secret_a}),
      ('owner internal space', {}, {'ownerToken': secret_a + ' middle'}),
      ('access ID internal space', {}, {'ownerToken': secret_a, 'accessClientID': 'id with-space', 'accessClientSecret': secret_b}),
      ('access secret internal space', {}, {'ownerToken': secret_a, 'accessClientID': 'fixture-id', 'accessClientSecret': secret_b + ' middle'}),
    ]
    for name, changes, values in cases:
      target = {**binding, **changes, 'credentialRef': str(uuid.uuid4())}
      cleanup_bindings.append(target)
      saved = invoke('put', target, values)
      rejected = saved.returncode != 0
      failures += int(not rejected)
      report(name, rejected=rejected, expected=True)
      invoke('remove', target)
    report('result', failingAssertions=failures)
  finally:
    if racer is not None and racer.poll() is None:
      racer.terminate(); racer.wait(timeout=5)
    for target in cleanup_bindings:
      invoke('remove', target)
      assert invoke('read', target).returncode == 1, 'exact fixture must be absent'
    report('cleanup', allRandomFixtureBindingsAbsent=True)
print(json.dumps({'log': str(log_path), 'sourceHash': source_hash, 'failingAssertions': failures}), flush=True)
print(log_path.read_text(), end='')
import shutil
shutil.rmtree(root)
sys.exit(1 if failures else 0)
