import importlib.util
import io
import json
import pathlib
import tempfile
import unittest
import zipfile

P = pathlib.Path(__file__).with_name('gate.py')
spec = importlib.util.spec_from_file_location('gate', P)
g = importlib.util.module_from_spec(spec) if P.exists() else None
if g:
    spec.loader.exec_module(g)


class GateTests(unittest.TestCase):
    def need(self):
        self.assertIsNotNone(g, 'trusted worker is not implemented')

    def test_policy_fails_closed_and_uses_whole_metrics(self):
        self.need()
        good = dict(coverage='80', duplicated_lines_density='3', reliability_rating='1',
                    security_rating='1', sqale_rating='1', violations='0', security_hotspots='0')
        self.assertEqual(g.evaluate(good), [])
        for key, value in [('coverage', '79.9'), ('duplicated_lines_density', '3.1'),
                           ('reliability_rating', '2'), ('security_rating', '2'),
                           ('sqale_rating', '2'), ('violations', '1'), ('coverage', 'NaN')]:
            with self.subTest(key=key, value=value):
                self.assertTrue(g.evaluate(dict(good, **{key: value})))
        for key in good:
            self.assertTrue(g.evaluate({k: v for k, v in good.items() if k != key}))
        self.assertTrue(g.evaluate(dict(good, security_hotspots='1')))
        self.assertEqual(g.evaluate(dict(good, security_hotspots='1', security_hotspots_reviewed='100')), [])
        self.assertEqual(g.evaluate(dict(good, security_hotspots='1', security_hotspots_reviewed='100.0')), [])
        self.assertTrue(g.evaluate(dict(good, security_hotspots='1', security_hotspots_reviewed='NaN')))
        self.assertTrue(g.evaluate({'new_coverage': '100'}))

    def test_candidate_and_run_binding(self):
        self.need()
        pr = {'number': 7, 'state': 'open', 'base': {'repo': {'full_name': g.REPO}, 'ref': 'main'},
              'head': {'sha': 'a' * 40, 'repo': {'full_name': 'someone/fork'}}}
        run = {'id': 12, 'run_attempt': 1, 'head_sha': 'a'*40, 'head_repository': {'full_name': 'someone/fork'},
               'event': 'pull_request', 'path': g.WORKFLOW,
               'repository': {'full_name': g.REPO}, 'status': 'completed', 'conclusion': 'success',
               'pull_requests': [{'number': 7, 'head': {'sha': 'a'*40, 'repo': {'name': 'fork', 'id': 123}}}]}
        self.assertTrue(g.eligible(pr, run))
        for key, value in [('head_sha', 'b'*40), ('event', 'push'), ('path', 'evil.yml'),
                           ('conclusion', 'cancelled'), ('repository', {'full_name': 'evil/repo'})]:
            self.assertFalse(g.eligible(pr, dict(run, **{key: value})))
        self.assertFalse(g.eligible(pr, dict(run, pull_requests=[])))
        self.assertFalse(g.eligible(dict(pr, state='closed'), run))

    def archive(self, entries):
        b = io.BytesIO()
        with zipfile.ZipFile(b, 'w') as z:
            for name, data in entries:
                z.writestr(name, data)
        return b.getvalue()

    def test_coverage_archive_and_source_binding(self):
        self.need()
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            (root/'src').mkdir()
            (root/'src/a.ts').write_text('const a = 1;\n')
            text = 'TN:\nSF:src/a.ts\nFN:1,a\nFNDA:1,a\nFNF:1\nFNH:1\nDA:1,1\nLF:1\nLH:1\nBRF:0\nBRH:0\nend_of_record\n'
            manifest = json.dumps({'sha': 'a'*40, 'repository': g.REPO, 'run_id': '12'})
            blob = self.archive([('lcov.info', text), ('binding.json', manifest)])
            self.assertEqual(g.coverage(blob, root, 'a'*40, 12), text)
            for path in ['../escape', '/tmp/a', 'src/../../x']:
                with self.assertRaises(g.Reject):
                    g.coverage(self.archive([(path, 'x')]), root, 'a'*40, 12)
            for bad in [text.replace('src/a.ts', '/etc/passwd'), text.replace('DA:1,1', 'DA:2,1'),
                        text.replace('DA:1,1', 'DA:1,-1'), text.replace('LF:1', 'LF:2'),
                        text.replace('end_of_record', 'UNKNOWN:x'), '']:
                with self.subTest(bad=bad), self.assertRaises(g.Reject):
                    g.coverage(self.archive([('lcov.info', bad), ('binding.json', manifest)]), root, 'a'*40, 12)
            with self.assertRaises(g.Reject):
                g.coverage(blob, root, 'b'*40, 12)
            (root/'src/a.ts').unlink()
            (root/'src/a.ts').symlink_to('/etc/passwd')
            with self.assertRaises(g.Reject):
                g.coverage(blob, root, 'a'*40, 12)

    def test_status_rechecks_head_and_deduplicates(self):
        self.need()
        calls = []
        with tempfile.TemporaryDirectory() as d:
            state = {}
            read = lambda: {'state': 'open', 'head': {'sha': 'a'*40}}
            self.assertTrue(g.publish(read, calls.append, state, 'a'*40, 'pending', 'Waiting', None))
            self.assertFalse(g.publish(read, calls.append, state, 'a'*40, 'pending', 'Waiting', None))
            self.assertFalse(g.publish(lambda: {'state': 'open', 'head': {'sha': 'b'*40}}, calls.append,
                                       state, 'a'*40, 'success', 'Passed', None))
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0]['context'], 'SonarQube / whole-candidate')

    def test_sandbox_command_does_not_mount_home_or_candidate_config(self):
        self.need()
        from unittest.mock import patch
        with patch.object(g.os, 'getuid', return_value=1001), patch.object(g.os, 'getgid', return_value=1001):
            cmd = g.sandbox('sha256:'+'a'*64, '/safe/source', '/safe/config', '/safe/output')
        self.assertIn('--read-only', cmd)
        self.assertIn('--cap-drop=ALL', cmd)
        self.assertIn('--user=1001:1001', cmd)
        self.assertIn('--tmpfs=/tmp:rw,exec,nosuid,size=1g,uid=1001,gid=1001', cmd)
        with patch.object(g.os, 'getuid', return_value=0), self.assertRaises(g.Reject):
            g.sandbox('sha256:'+'a'*64, '/safe/source', '/safe/config', '/safe/output')
        self.assertNotIn('/var/run/docker.sock', ' '.join(cmd))
        self.assertNotIn('SONAR_TOKEN=', ' '.join(cmd))
        with self.assertRaises(g.Reject):
            g.sandbox('latest', '/safe/source', '/safe/config', '/safe/output')

    def test_diagnostic_redacts_arbitrary_exception_and_persists(self):
        self.need()
        with tempfile.TemporaryDirectory() as d:
            try:
                raise ValueError('secret-token-xyz')
            except ValueError as e:
                p = g.diagnostic(pathlib.Path(d), 'scan', e, 'uncertain')
            report = p.read_text()
            self.assertNotIn('secret-token-xyz', report)
            data = json.loads(report)
            self.assertEqual(data['phase'], 'scan')
            self.assertEqual(data['mutation'], 'uncertain')
            self.assertTrue(data['stack'])
            self.assertEqual(data['exception'], 'ValueError')


class WorkerTests(unittest.TestCase):
    def test_scanner_entrypoint_explicitly_loads_only_trusted_options(self):
        wrapper = P.with_name('scanner.mjs')
        self.assertTrue(wrapper.exists(), 'bootstrap config loader missing')
        text = wrapper.read_text()
        self.assertIn("'/config/options.json'", text)
        self.assertIn('await scan({ options })', text)

    def test_candidate_json_configs_are_not_materialized(self):
        self.assertTrue(hasattr(g, 'source_suffixes'), 'explicit source suffix policy missing')
        self.assertNotIn('.json', g.source_suffixes())
        self.assertNotIn('.properties', g.source_suffixes())

    def test_sandbox_timeout_removes_only_its_named_container(self):
        self.assertTrue(hasattr(g, 'run_sandbox'), 'bounded container lifecycle missing')
        from unittest.mock import patch
        import subprocess
        calls = []
        def run(args, **kwargs):
            calls.append(args)
            if args[:2] == ['docker', 'run']:
                raise subprocess.TimeoutExpired('docker', 1)
            if args[:2] == ['docker', 'inspect']:
                return subprocess.CompletedProcess(args, 1, b'', b'')
            return subprocess.CompletedProcess(args, 0, b'', b'')
        with patch.object(g.subprocess, 'run', run):
            with self.assertRaises(subprocess.TimeoutExpired):
                g.run_sandbox(['docker', 'run', '--rm', 'sha256:'+'a'*64])
        name = calls[0][calls[0].index('--name')+1]
        self.assertRegex(name, '^commonfield-gate-[a-f0-9]{32}$')
        self.assertIn(['docker', 'rm', '-f', name], calls)
        self.assertIn(['docker', 'inspect', name], calls)

    def test_receipt_identity_changes_when_installed_policy_changes(self):
        self.assertTrue(hasattr(g, 'receipt_key'), 'version-bound receipts missing')
        run = {'id': 12, 'run_attempt': 1}
        self.assertNotEqual(g.receipt_key('a'*40, run, 'policy1'), g.receipt_key('a'*40, run, 'policy2'))

    def test_run_head_repository_mismatch_is_rejected(self):
        pr = {'number':7, 'state':'open','head':{'sha':'a'*40,'repo':{'full_name':'person/fork'}},
              'base':{'ref':'main','repo':{'full_name':g.REPO}}}
        run = {'head_sha':'a'*40,'head_repository':{'full_name':'other/fork'},'event':'pull_request',
               'path':g.WORKFLOW,'repository':{'full_name':g.REPO},'status':'completed','conclusion':'success',
               'pull_requests':[{'number':7,'head':{'sha':'a'*40}}]}
        self.assertFalse(g.eligible(pr,run))

    def test_cached_green_requires_current_artifact_and_analysis(self):
        w = object.__new__(g.Worker)
        w.cfg = {'worker_sha256': 'review1'}
        w.phase = 'test'
        pr = {'number':7,'state':'open','base':{'ref':'main','repo':{'full_name':g.REPO}},
              'head':{'sha':'a'*40,'repo':{'full_name':g.REPO}}}
        run = {'id':12,'run_attempt':1,'head_sha':'a'*40,'head_repository':{'full_name':g.REPO},
               'repository':{'full_name':g.REPO},'path':g.WORKFLOW,'event':'pull_request',
               'status':'completed','conclusion':'success','pull_requests':[{'number':7,'head':{'sha':'a'*40}}]}
        w.runs = lambda sha: [run]
        key = g.receipt_key('a'*40,run,'review1')
        w.state = {'receipts':{key:{'failures':[], 'sha':'a'*40,'project':'test-project','analysis_id':'analysis',
                                  'artifact_id':123,'artifact_digest':'sha256:'+'a'*64}}}
        posts = []
        w.status = lambda *args: posts.append(args[1])
        w.pages = lambda *args: []
        w.phases = lambda run: True
        with self.assertRaises(g.Reject):
            w.run_pr(pr)
        self.assertNotIn('success',posts)

    def test_malformed_lcov_function_and_branch_totals_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            (root/'src').mkdir()
            (root/'src/a.ts').write_text('const a=1;\n')
            base = 'SF:src/a.ts\nDA:1,1\nLF:1\nLH:1\n'
            manifest = json.dumps({'sha':'a'*40,'repository':g.REPO,'run_id':'1'})
            for extra in ['FNF:0\nFNH:1\n', 'BRF:0\nBRH:1\n', 'FN:2,a\nFNDA:1,a\nFNF:1\nFNH:1\n']:
                blob = GateTests().archive([('lcov.info',base+extra+'end_of_record\n'),('binding.json',manifest)])
                with self.subTest(extra=extra), self.assertRaises(g.Reject):
                    g.coverage(blob,root,'a'*40,1)

    def test_diagnostics_include_only_allowlisted_attempt_context(self):
        with tempfile.TemporaryDirectory() as d:
            try:
                raise g.Reject('scan_failure')
            except g.Reject as e:
                p = g.diagnostic(pathlib.Path(d), 'scan', e, 'uncertain',
                                 {'project': 'commonfield-pr-7-test', 'sha': 'a'*40, 'token': 'secret'})
            data = json.loads(p.read_text())
            self.assertEqual(data['context']['project'], 'commonfield-pr-7-test')
            self.assertNotIn('secret',p.read_text())

    def test_poll_records_failure_and_returns_failure_count(self):
        w = object.__new__(g.Worker)
        with tempfile.TemporaryDirectory() as d:
            w.root = pathlib.Path(d)
            w.phase = 'test_boundary'
            w.pages = lambda *args: [{'number':7}]
            def reject(pr):
                raise g.Reject('test_boundary_rejected')
            w.run_pr = reject
            posts = []
            w.status = lambda *args: posts.append(args[1])
            self.assertEqual(w.poll(),1)
            self.assertEqual(posts,['error'])
            self.assertEqual(len(list((w.root/'diagnostics').glob('*.json'))),1)

    def test_missing_ci_never_scans(self):
        self.assertTrue(hasattr(g, 'Worker'), 'polling worker missing')
        w = object.__new__(g.Worker)
        w.state = {}
        w.cfg = {}
        w.phase = 'start'
        w.pr = lambda n: {'number': n, 'state': 'open', 'head': {'sha': 'a'*40},
                          'base': {'ref': 'main', 'repo': {'full_name': g.REPO}}}
        w.runs = lambda sha: []
        posts = []
        w.status = lambda pr, status, description, url=None: posts.append(status)
        w.run_pr(w.pr(7))
        self.assertEqual(posts, ['pending'])

    def test_analysis_revision_and_exact_analysis_id(self):
        self.assertTrue(hasattr(g, 'verify_analysis'), 'analysis binding missing')
        a = {'key': 'id1', 'revision': 'a'*40}
        self.assertEqual(g.verify_analysis([a], 'id1', 'a'*40), a)
        for key, sha in [('id2', 'a'*40), ('id1', 'b'*40)]:
            with self.assertRaises(g.Reject):
                g.verify_analysis([a], key, sha)

    def test_source_materializer_ignores_scripts_rejects_symlinks(self):
        self.assertTrue(hasattr(g, 'materialize'), 'safe source materializer missing')
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            repo = root/'repo'
            repo.mkdir()
            import subprocess
            subprocess.run(['git', 'init', '-q', str(repo)], check=True)
            (repo/'src').mkdir()
            (repo/'src/a.ts').write_text('export const x = 1;\n')
            (repo/'package.json').write_text('{"scripts":{"evil":"exit 9"}}')
            subprocess.run(['git', '-C', str(repo), 'add', '.'], check=True)
            subprocess.run(['git', '-C', str(repo), '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
                            'commit', '-qm', 'fixture'], check=True)
            sha = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD']).decode().strip()
            out = root/'out'
            import os, stat
            previous_umask = os.umask(0o077)
            try:
                out.mkdir()
                g.materialize(repo, sha, out)
            finally:
                os.umask(previous_umask)
            self.assertEqual(stat.S_IMODE(out.stat().st_mode), 0o755)
            self.assertEqual(stat.S_IMODE((out/'src').stat().st_mode), 0o755)
            self.assertEqual(stat.S_IMODE(root.stat().st_mode), 0o700)
            self.assertTrue((out/'src/a.ts').is_file())
            self.assertFalse((out/'package.json').exists())
            (repo/'src/link.ts').symlink_to('/etc/passwd')
            subprocess.run(['git', '-C', str(repo), 'add', '.'], check=True)
            subprocess.run(['git', '-C', str(repo), '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
                            'commit', '-qm', 'symlink'], check=True)
            sha = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD']).decode().strip()
            with self.assertRaises(g.Reject):
                g.materialize(repo, sha, root/'out2')


class PhaseTests(unittest.TestCase):
    def reports(self, root):
        (root/'src').mkdir(exist_ok=True)
        (root/'src/a.ts').write_text('const a = 1;\nconst b = 2;\n')
        report = dict(numTotalTestSuites=1, numPassedTestSuites=1, numFailedTestSuites=0,
                      numPendingTestSuites=0, numTotalTests=1, numPassedTests=1,
                      numFailedTests=0, numPendingTests=0, numTodoTests=0, success=True,
                      snapshot={'failure': False}, testResults=[{'name': '/test.ts', 'status': 'passed',
                      'message': '', 'assertionResults': [{'status': 'passed', 'failureMessages': []}]}])
        (root/'tests.json').write_text(json.dumps(report))
        (root/'runtime.json').write_text(json.dumps({'reason': 'passed', 'unhandled': 0, 'modules': 1}))
        (root/'exit').write_text('1\n')
        (root/'stderr').write_text('ERROR: Coverage for lines (50%) does not meet global threshold (80%)\n')
        (root/'lcov.info').write_text('SF:src/a.ts\nDA:1,1\nDA:2,0\nLF:2\nLH:1\nend_of_record\n')
        return report

    def validate(self, root):
        from unittest.mock import patch
        with patch.object(g.pathlib.Path, 'cwd', return_value=root):
            return g.validate_ci(root, root/'lcov.info')

    def test_only_proven_coverage_failure_is_classified(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            self.reports(root)
            self.assertEqual(self.validate(root), 'coverage-only')
            (root/'exit').write_text('0')
            (root/'stderr').write_text('')
            (root/'lcov.info').write_text((root/'lcov.info').read_text().replace('DA:2,0', 'DA:2,1').replace('LH:1', 'LH:2'))
            self.assertEqual(self.validate(root), 'success')
            (root/'stderr').write_text('Error: unknown collector failure\n')
            with self.assertRaises(g.Reject):
                self.validate(root)

    def test_collector_failures_are_closed(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            for fault in ('test', 'suite', 'partial', 'unhandled', 'missing', 'unknown', 'exit', 'coverage'):
                with self.subTest(fault=fault):
                    report = self.reports(root)
                    if fault == 'test':
                        report['testResults'][0]['assertionResults'][0]['status'] = 'failed'
                    if fault == 'suite':
                        report['numFailedTestSuites'] = 1
                    if fault == 'partial':
                        report['numTotalTests'] = 2
                    (root/'tests.json').write_text(json.dumps(report))
                    if fault == 'unhandled':
                        (root/'runtime.json').write_text('{"reason":"passed","unhandled":1,"modules":1}')
                    if fault == 'missing':
                        (root/'tests.json').unlink()
                    if fault == 'unknown':
                        (root/'stderr').write_text((root/'stderr').read_text() + 'Error: collector crashed\n')
                    if fault == 'exit':
                        (root/'exit').write_text('2')
                    if fault == 'coverage':
                        (root/'lcov.info').unlink()
                    with self.assertRaises(g.Reject):
                        self.validate(root)

    def job(self, run, negative=True):
        names = ['Checkout', 'Setup Node', 'Install', 'Trusted worker regression suite',
                 'Full unit suite and coverage', 'Validate test and coverage results', 'Types', 'Lint',
                 'Bind coverage', 'Upload coverage', 'Enforce coverage threshold']
        return dict(run_id=run['id'], run_attempt=run['run_attempt'], head_sha=run['head_sha'],
                    name='Tests, types, lint and coverage', status='completed',
                    conclusion='failure' if negative else 'success', steps=[dict(name=n,
                    status='completed', conclusion='failure' if negative and n == names[-1] else 'success')
                    for n in names])

    def test_authenticated_exact_attempt_phase_contract(self):
        run = dict(id=12, run_attempt=1, head_sha='a'*40, conclusion='failure')
        self.assertTrue(g.phases_eligible(run, [self.job(run)]))
        # Pinned setup-node has post-if: success(); the final coverage failure skips it.
        post_job = self.job(run)
        post_job['steps'].append(dict(name='Post Setup Node', status='completed', conclusion='skipped'))
        self.assertTrue(g.phases_eligible(run, [post_job]))
        post_job['steps'][-1]['conclusion'] = 'failure'
        self.assertFalse(g.phases_eligible(run, [post_job]))
        import copy
        for fault in ('Types', 'Lint', 'Validate test and coverage results', 'Full unit suite and coverage',
                      'missing', 'attempt', 'sha', 'extra', 'job'):
            with self.subTest(fault=fault):
                job = copy.deepcopy(self.job(run))
                if fault in [s['name'] for s in job['steps']]:
                    next(s for s in job['steps'] if s['name'] == fault)['conclusion'] = 'failure'
                if fault == 'missing': job['steps'].pop(5)
                if fault == 'attempt': job['run_attempt'] = 2
                if fault == 'sha': job['head_sha'] = 'b'*40
                if fault == 'extra': job['steps'].append(dict(name='Unexpected', status='completed', conclusion='failure'))
                if fault == 'job': job['name'] = 'Other job'
                self.assertFalse(g.phases_eligible(run, [job]))

    def worker(self, root):
        w = object.__new__(g.Worker)
        w.root, w.cfg, w.state = root, {'worker_sha256': 'review1'}, {}
        pr = {'number': 7, 'state': 'open', 'base': {'ref': 'main', 'repo': {'full_name': g.REPO}},
              'head': {'sha': 'a'*40, 'repo': {'full_name': g.REPO}}}
        run = dict(id=12, run_attempt=1, head_sha='a'*40, head_repository={'full_name': g.REPO},
                   repository={'full_name': g.REPO}, path=g.WORKFLOW, event='pull_request',
                   status='completed', conclusion='failure', pull_requests=[{'number':7, 'head':{'sha':'a'*40}}])
        w.runs = lambda sha: [run]
        w.github = lambda endpoint, **kwargs: {'jobs': [self.job(run)], 'total_count': 1}
        w.pages = lambda endpoint, key=None: [self.job(run)]
        posts = []
        w.status = lambda pr, state, *args: posts.append(state)
        w.save = lambda: None
        w.artifact = lambda *args: {'id':123, 'digest':'sha256:'+'a'*64}
        receipt = dict(failures=['coverage', 'reliability_rating', 'violations'], project='test',
                       analysis_id='analysis', artifact_id=123, artifact_digest='sha256:'+'a'*64)
        def sonar(endpoint, params, post=False):
            if endpoint == 'measures/component':
                metrics = receipt.get('metrics', LiveMetricsTests.good())
                return {'component': {'key': receipt['project'], 'measures':
                    [dict(metric=k, value=v) for k, v in metrics.items()]}}
            return {'analyses': [{'key':'analysis', 'revision':'a'*40}]}
        w.sonar = sonar
        return w, pr, run, posts, receipt

    def test_coverage_only_ci_reaches_real_policy_failure(self):
        from unittest.mock import patch
        import hashlib
        for sonar_fails in (True, False):
            with self.subTest(sonar_fails=sonar_fails), tempfile.TemporaryDirectory() as d:
                w, pr, run, posts, receipt = self.worker(pathlib.Path(d))
                # Synthetic Sonar API fixture, not a claim of a live analysis.
                metrics = dict(coverage='59.7' if sonar_fails else '90', duplicated_lines_density='0.6',
                               reliability_rating='3' if sonar_fails else '1', security_rating='1',
                               sqale_rating='1', violations='9' if sonar_fails else '0', security_hotspots='0')
                receipt['failures'] = g.evaluate(metrics)
                w.artifact = lambda *args: {'id':123,'digest':'sha256:'+hashlib.sha256(b'zip').hexdigest()}
                w.github = lambda endpoint, **kwargs: b'zip'
                w.source = lambda pr, root: root
                scans = []
                def scan(*args):
                    scans.append(True)
                    return dict(receipt)
                w.scan = scan
                with patch.object(g, 'coverage', return_value='real LCOV'):
                    w.run_pr(pr)
                self.assertEqual(scans, [True])
                self.assertEqual(posts[-1], 'failure')
                self.assertIn('vitest_lines', next(iter(w.state['receipts'].values()))['failures'])

    def test_phase_failure_never_reaches_scan(self):
        with tempfile.TemporaryDirectory() as d:
            for fault in ('Types', 'Lint', 'Validate test and coverage results', 'Enforce coverage threshold'):
                with self.subTest(fault=fault):
                    w, pr, run, posts, receipt = self.worker(pathlib.Path(d))
                    job = self.job(run)
                    next(s for s in job['steps'] if s['name'] == fault)['conclusion'] = 'cancelled'
                    w.pages = lambda *args: [job]
                    w.scan = lambda *args: self.fail('invalid CI reached scanner')
                    w.run_pr(pr)
                    self.assertEqual(posts, ['failure'])

    def test_new_attempt_during_final_jobs_readback_defers_policy(self):
        with tempfile.TemporaryDirectory() as d:
            w, pr, run, posts, receipt = self.worker(pathlib.Path(d))
            latest = dict(run)
            w.runs = lambda sha: [dict(latest)]
            calls = []
            def jobs(*args):
                calls.append(args[0])
                job = self.job(run)
                if len(calls) == 2:
                    latest.update(run_attempt=2, status='queued', conclusion=None)
                return [job]
            w.pages = jobs
            w.state = {'receipts': {g.receipt_key('a'*40,run,'review1'): receipt}}
            w.run_pr(pr)
            self.assertEqual(posts, ['pending'])
            self.assertTrue(all('/attempts/1/jobs' in endpoint for endpoint in calls))

    def test_same_head_rerun_never_publishes_old_terminal_policy(self):
        from unittest.mock import patch
        import hashlib
        for cached in (True, False):
            for status, conclusion in [('queued',None), ('in_progress',None), ('completed','failure'),
                                       ('completed','cancelled'), ('completed','success')]:
                with self.subTest(cached=cached, status=status, conclusion=conclusion), tempfile.TemporaryDirectory() as d:
                    w, pr, run, posts, receipt = self.worker(pathlib.Path(d))
                    run['conclusion'] = 'success'
                    receipt['failures'] = []
                    latest = dict(run)
                    w.runs = lambda sha: [dict(latest)]
                    def jobs(endpoint, key=None):
                        job = self.job(latest, negative=latest['conclusion'] == 'failure')
                        if latest['run_attempt'] == 2 and latest['conclusion'] == 'failure':
                            next(s for s in job['steps'] if s['name'] == 'Types')['conclusion'] = 'failure'
                        return [job]
                    w.pages = jobs
                    def change():
                        latest.update(run_attempt=2, status=status, conclusion=conclusion)
                    if cached:
                        w.state = {'receipts': {g.receipt_key('a'*40,run,'review1'): receipt}}
                        previous_sonar = w.sonar
                        def sonar(*args):
                            change()
                            return previous_sonar(*args)
                        w.sonar = sonar
                    else:
                        w.artifact = lambda *args: {'id':123,'digest':'sha256:'+hashlib.sha256(b'zip').hexdigest()}
                        w.source = lambda pr, root: root
                        w.github = lambda endpoint, **kwargs: b'zip'
                        def scan(*args):
                            change()
                            return dict(receipt)
                        w.scan = scan
                    with patch.object(g, 'coverage', return_value='LCOV'):
                        w.run_pr(pr)
                    # Both old success AND old policy failure are deferred to the new attempt.
                    self.assertEqual(posts[-1], 'failure' if conclusion in ('cancelled', 'failure') else 'pending')


class ClassificationTests(unittest.TestCase):
    """Synthetic API responses; exercise the real scan, not a live Sonar server."""
    # A test-only reviewed source snapshot keeps this suite valid when real canvas
    # bytes change (which must revoke the PRODUCTION approval, not break the suite).
    fixture_data = b'reviewed spatial canvas fixture\n'
    approved_hash = g.hashlib.sha256(fixture_data).hexdigest()

    def test_production_approval_is_exact_and_not_configurable(self):
        self.assertEqual(g.CANVAS_PATH, 'src/web/main.tsx')
        self.assertEqual(g.CANVAS_SHA256, 'dfe8fa43b17a4315375a984b38f0e512d960da11881c165d413b594e8fb0d086')
        self.assertEqual(g.CANVAS_FINDINGS, (('typescript:S6847', 1250), ('typescript:S6845', 1255)))
        self.assertIn(g.CANVAS_SHA256, g.CANVAS_RATIONALE)

    def fixture(self, root, changed=False, faults=None):
        import copy
        w = object.__new__(g.Worker)
        w.cfg = {'sonar_url': 'http://127.0.0.1:9000', 'scanner_image': 'sha256:'+'a'*64}
        pr = {'number': 7, 'head': {'sha': 'a'*40}, 'approved_source_sha256': self.approved_hash}
        run = {'id': 12, 'run_attempt': 1}
        source = root/'candidate'
        (source/'src/web').mkdir(parents=True)
        (source/'src/web/main.tsx').write_bytes(self.fixture_data + (b'\n' if changed else b''))
        state = {'issues': [], 'writes': [], 'reads': [], 'key': None}
        faults = faults or {}

        def sonar(endpoint, params, post=False):
            if post:
                state['writes'].append((endpoint, dict(params)))
            else:
                state['reads'].append((endpoint, dict(params)))
            if endpoint == 'projects/create':
                state['key'] = params['project']
                state['issues'] = [dict(key='issue-'+str(i), rule=rule, line=line,
                    component=state['key']+':src/web/main.tsx', status='OPEN', resolution='', comments=[])
                    for i, (rule, line) in enumerate([('typescript:S6847', 1250), ('typescript:S6845', 1255)])]
                if faults.get('edit'):
                    faults['edit'](state['issues'])
                return {}
            if endpoint == 'components/show':
                return {'component': {'key': state['key']}}
            if endpoint == 'user_tokens/generate':
                return {'token': 'scanner-only-fixture', 'type': 'PROJECT_ANALYSIS_TOKEN'}
            if endpoint in ('user_tokens/revoke', 'user_tokens/search'):
                return {'userTokens': []}
            if endpoint == 'ce/task':
                return {'task': {'id': 'task', 'componentKey': state['key'], 'status': 'SUCCESS', 'analysisId': 'analysis'}}
            if endpoint == 'project_analyses/search':
                return {'analyses': [{'key': 'analysis', 'revision': 'a'*40}]}
            if endpoint == 'issues/search':
                if 'issues' in params:
                    rows = [i for i in state['issues'] if i['key'] == params['issues']]
                else:
                    self.assertEqual(params['componentKeys'], state['key'])
                    self.assertEqual(params['resolved'], 'false')
                    rows = [i for i in state['issues'] if not i['resolution']]
                total = len(rows)
                if 'p' in params:
                    start = (params['p']-1)*params['ps']
                    rows = rows[start:start+params['ps']]
                return {'issues': copy.deepcopy(rows), 'paging': {'total': total}}
            if endpoint == 'issues/add_comment':
                issue = next(i for i in state['issues'] if i['key'] == params['issue'])
                if not faults.get('missing_comment'):
                    issue['comments'].append({'markdown': params['text']})
                return {'issue': copy.deepcopy(issue)}
            if endpoint == 'issues/do_transition':
                self.assertEqual(params['transition'], 'falsepositive')
                if faults.get('transition') == 'error':
                    raise g.Reject('fixture_transition_failed')
                issue = next(i for i in state['issues'] if i['key'] == params['issue'])
                if faults.get('transition') != 'mismatch':
                    issue.update(status='RESOLVED', resolution='FALSE-POSITIVE')
                if faults.get('transition') == 'wrong-location':
                    issue['line'] = 1251
                return {'issue': copy.deepcopy(issue)}
            if endpoint == 'measures/component':
                metrics = LiveMetricsTests.good()
                metrics['violations'] = str(sum(not i['resolution'] for i in state['issues']))
                return {'component': {'key': state['key'], 'measures': [dict(metric=k, value=v) for k, v in metrics.items()]}}
            self.fail('Unexpected API request: '+endpoint)
        w.sonar = sonar
        return w, pr, run, source, state

    def scan(self, root, changed=False, faults=None, source_bytes=None):
        from contextlib import nullcontext
        from unittest.mock import patch
        w, pr, run, source, state = self.fixture(root, changed, faults)
        if source_bytes is not None:
            (source/'src/web/main.tsx').write_bytes(source_bytes)
        approval = patch.object(g, 'CANVAS_SHA256', self.approved_hash) if source_bytes is None else nullcontext()
        def sandbox(args):
            (root/'output/report-task.txt').write_text('ceTaskId=task\nprojectKey='+state['key']+'\n')
        with approval, patch.object(g, 'run_sandbox', sandbox), patch.object(g.os, 'getuid', return_value=1001), patch.object(g.os, 'getgid', return_value=1001):
            receipt = w.scan(pr, run, source, 'fixture LCOV', root)
        return w, receipt, state

    def test_real_candidate_bytes_obey_production_approval_without_test_override(self):
        actual = (P.parents[2]/'src/web/main.tsx').read_bytes()
        for data in (actual, actual+b'\n'):
            with self.subTest(source_hash=g.hashlib.sha256(data).hexdigest()), tempfile.TemporaryDirectory() as d:
                w, receipt, state = self.scan(pathlib.Path(d), source_bytes=data)
                approved = g.hashlib.sha256(data).hexdigest() == g.CANVAS_SHA256
                self.assertEqual(receipt['metrics']['violations'], '0' if approved else '2')
                self.assertEqual(len(receipt['classifications']), 2 if approved else 0)

    def test_exact_source_and_pair_get_two_audited_classifications_and_real_metrics(self):
        with tempfile.TemporaryDirectory() as d:
            w, receipt, state = self.scan(pathlib.Path(d))
            self.assertEqual(receipt['metrics']['violations'], '0')
            self.assertEqual(receipt['failures'], [])
            writes = state['writes']
            self.assertEqual(len([e for e, p in writes if e == 'issues/add_comment']), 2)
            self.assertEqual(len([e for e, p in writes if e == 'issues/do_transition']), 2)
            audit = receipt['classifications']
            self.assertEqual(receipt['source_binding'], {'path': 'src/web/main.tsx', 'sha256': self.approved_hash})
            self.assertEqual({a['key'] for a in audit}, {'issue-0', 'issue-1'})
            for a in audit:
                self.assertEqual(a['resolution'], 'FALSE-POSITIVE')
                self.assertEqual(a['status'], 'RESOLVED')
                self.assertIn('https://www.w3.org/TR/wai-aria-1.2/#application', a['rationale'])
                self.assertEqual(a['source_sha256'], self.approved_hash)
                self.assertEqual(a['analysis_id'], receipt['analysis_id'])
                self.assertEqual(a['sha'], 'a'*40)
            before = list(writes)
            # Repeating a proven classification cannot add comments or transitions.
            from unittest.mock import patch
            with patch.object(g, 'CANVAS_SHA256', self.approved_hash):
                self.assertEqual(w.classify_canvas(receipt['project'], 'analysis', 'a'*40, self.approved_hash), [])
            self.assertEqual(writes, before)

    def test_changed_source_cannot_be_authorized_by_pr_metadata(self):
        with tempfile.TemporaryDirectory() as d:
            w, receipt, state = self.scan(pathlib.Path(d), changed=True)
            self.assertEqual(receipt['metrics']['violations'], '2')
            self.assertIn('violations', receipt['failures'])
            self.assertFalse(any(e.startswith('issues/') for e, p in state['writes']))

    def test_other_rules_paths_lines_and_projects_stay_unresolved(self):
        for field, value in [('rule', 'typescript:S9999'), ('component', 'elsewhere:src/web/main.tsx'),
                             ('component', 'another-project:src/web/main.tsx'), ('line', 1251),
                             ('component', ':src/web/other.tsx')]:
            with self.subTest(field=field, value=value), tempfile.TemporaryDirectory() as d:
                def edit(issues):
                    issues[0][field] = value
                w, receipt, state = self.scan(pathlib.Path(d), faults={'edit': edit})
                self.assertEqual(receipt['metrics']['violations'], '1')
                self.assertIn('violations', receipt['failures'])
                self.assertEqual(state['issues'][0]['resolution'], '')
                self.assertEqual([p['issue'] for e, p in state['writes'] if e == 'issues/do_transition'], ['issue-1'])

    def test_already_false_positive_has_no_duplicate_writes(self):
        with tempfile.TemporaryDirectory() as d:
            def edit(issues):
                for issue in issues:
                    issue.update(status='RESOLVED', resolution='FALSE-POSITIVE')
            w, receipt, state = self.scan(pathlib.Path(d), faults={'edit': edit})
            self.assertEqual(receipt['metrics']['violations'], '0')
            self.assertFalse(any(e.startswith('issues/') for e, p in state['writes']))

    def test_paginated_unrelated_findings_are_preserved_in_real_metrics(self):
        with tempfile.TemporaryDirectory() as d:
            def edit(issues):
                unrelated = [dict(issues[0], key='unrelated-'+str(n), rule='typescript:S9999') for n in range(501)]
                issues[:] = unrelated + issues
            w, receipt, state = self.scan(pathlib.Path(d), faults={'edit': edit})
            self.assertEqual(receipt['metrics']['violations'], '501')
            self.assertEqual(len(receipt['classifications']), 2)
            self.assertIn('violations', receipt['failures'])
            self.assertEqual([p['p'] for e, p in state['reads'] if e == 'issues/search' and 'p' in p], [1, 2])
            self.assertEqual(sum(not i['resolution'] for i in state['issues']), 501)

    def test_ambiguous_duplicate_matches_fail_without_classification_writes(self):
        with tempfile.TemporaryDirectory() as d:
            w, pr, run, source, state = self.fixture(pathlib.Path(d))
            w.sonar('projects/create', {'project': 'owned'}, True)
            state['issues'].append(dict(state['issues'][0], key='duplicate'))
            from unittest.mock import patch
            with patch.object(g, 'CANVAS_SHA256', self.approved_hash), self.assertRaises(g.Reject):
                w.classify_canvas('owned', 'analysis', 'a'*40, self.approved_hash)
            self.assertFalse(any(e.startswith('issues/') for e, p in state['writes']))

    def test_missing_comment_readback_fails_before_transition(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaisesRegex(g.Reject, 'classification_comment_readback'):
                self.scan(pathlib.Path(d), faults={'missing_comment': True})

    def test_failed_transition_or_wrong_readback_cannot_return_green(self):
        for fault in ('error', 'mismatch', 'wrong-location'):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as d:
                with self.assertRaises(g.Reject):
                    self.scan(pathlib.Path(d), faults={'transition': fault})


class LiveMetricsTests(unittest.TestCase):
    @staticmethod
    def good():
        return dict(coverage='86.7', duplicated_lines_density='0.6', reliability_rating='1',
                    security_rating='1', sqale_rating='1', violations='0', security_hotspots='0')

    def exercise(self, root, cached, old, current, conclusion='success', fault=None):
        from unittest.mock import patch
        import copy
        w, pr, run, posts, receipt = PhaseTests().worker(root)
        run['conclusion'] = conclusion
        w.phases = lambda run: True
        receipt.update(metrics=old, failures=g.evaluate(old), sha='a'*40, run_id=12, run_attempt=1)
        w.artifact = lambda *args: {'id': 123, 'digest': 'sha256:'+g.hashlib.sha256(b'zip').hexdigest()}
        receipt['artifact_digest'] = w.artifact()['digest']
        w.source = lambda pr, root: root
        w.github = lambda *args, **kwargs: b'zip'
        w.scan = lambda *args: copy.deepcopy(receipt)
        reads = []
        def sonar(endpoint, params, post=False):
            self.assertFalse(post, 'cached/terminal refresh must not classify issues')
            reads.append(endpoint)
            if endpoint == 'project_analyses/search':
                aid = 'changed' if fault == 'analysis' and reads.count(endpoint) > 1 else 'analysis'
                return {'analyses': [{'key': aid, 'revision': 'a'*40}]}
            self.assertEqual(endpoint, 'measures/component')
            return {'component': {'key': 'other' if fault == 'project' else 'test', 'measures':
                [dict(metric=k, value=v) for k, v in current.items()]}}
        w.sonar = sonar
        if cached:
            w.state = {'receipts': {g.receipt_key('a'*40, run, 'review1'): copy.deepcopy(receipt)}}
        with patch.object(g, 'coverage', return_value='LCOV'):
            w.run_pr(pr)
        return posts, next(iter(w.state['receipts'].values())), reads

    def test_fresh_and_cached_reopened_issue_changes_green_to_failure(self):
        for cached in (True, False):
            with self.subTest(cached=cached), tempfile.TemporaryDirectory() as d:
                posts, receipt, reads = self.exercise(pathlib.Path(d), cached, self.good(), dict(self.good(), violations='1'))
                self.assertEqual(posts[-1], 'failure')
                self.assertEqual(receipt['metrics']['violations'], '1')
                self.assertIn('violations', receipt['failures'])
                self.assertEqual(reads[-3:], ['project_analyses/search', 'measures/component', 'project_analyses/search'])

    def test_authoritative_classification_metrics_change_failure_to_green(self):
        for cached in (True, False):
            with self.subTest(cached=cached), tempfile.TemporaryDirectory() as d:
                posts, receipt, reads = self.exercise(pathlib.Path(d), cached, dict(self.good(), violations='2'), self.good())
                self.assertEqual(posts[-1], 'success')
                self.assertEqual(receipt['metrics']['violations'], '0')
                self.assertEqual(receipt['failures'], [])

    def test_cached_missing_metric_fails_closed(self):
        with tempfile.TemporaryDirectory() as d:
            metrics = self.good()
            del metrics['coverage']
            posts, receipt, reads = self.exercise(pathlib.Path(d), True, self.good(), metrics)
            self.assertEqual(posts[-1], 'failure')
            self.assertIn('coverage', receipt['failures'])

    def test_cached_proven_vitest_failure_is_not_erased_by_sonar_green(self):
        with tempfile.TemporaryDirectory() as d:
            posts, receipt, reads = self.exercise(pathlib.Path(d), True, self.good(), self.good(), conclusion='failure')
            self.assertEqual(posts[-1], 'failure')
            self.assertEqual(receipt['failures'], ['vitest_lines'])

    def test_refresh_rejects_analysis_race_and_wrong_measure_project(self):
        for fault in ('analysis', 'project'):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as d:
                with self.assertRaises(g.Reject):
                    self.exercise(pathlib.Path(d), True, self.good(), self.good(), fault=fault)


if __name__ == '__main__':
    unittest.main()
