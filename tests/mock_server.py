import sys, json
def main():
    for line in sys.stdin:
        line = line.strip()
        if not line: continue
        try:
            req = json.loads(line)
            m = req.get('method','')
            if m == 'ping':
                resp = {'id': req.get('id'), 'result': {'ok': True, 'pong': True, 'py': 'mock'}}
            elif m == 'echo':
                resp = {'id': req.get('id'), 'result': {'ok': True, 'echo': req.get('params', {})}}
            elif m == 'error':
                resp = {'id': req.get('id'), 'error': 'mock error boom'}
            elif m == 'sleep':
                import time; time.sleep(req.get('params',{}).get('ms',100)/1000.0)
                resp = {'id': req.get('id'), 'result': {'ok': True, 'slept': True}}
            else:
                resp = {'id': req.get('id'), 'error': 'unknown: ' + m}
        except Exception as e:
            resp = {'id': None, 'error': str(e)}
        sys.stdout.write(json.dumps(resp) + '\n')
        sys.stdout.flush()
if __name__ == '__main__': main()