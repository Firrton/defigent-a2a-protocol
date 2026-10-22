#!/usr/bin/env python3
"""¿Cómo reaccionó el server a los mensajes de 紫薇 (Ziwei)? Respuestas, estados, wake queue."""
import json, sqlite3, time

db = sqlite3.connect('/home/ubuntu/.hermes/cache/scratch/defigent_a2a.db')
db.row_factory = sqlite3.Row
rows = db.execute("SELECT context_id, role, text, ts FROM messages WHERE context_id LIKE 't-anon-1792626%' ORDER BY ts").fetchall()
for r in rows:
    ts = time.strftime('%H:%M:%S', time.localtime(r['ts'] / 1000))
    print('[{}] [{}] {!r}'.format(ts, r['role'], (r['text'] or '')[:120]))
print()
tasks = db.execute("SELECT context_id, state FROM tasks WHERE context_id LIKE 't-anon-1792626%'").fetchall()
for t in tasks:
    print(t['context_id'], '->', t['state'])
wq = [json.loads(l) for l in open('/home/ubuntu/.hermes/cache/scratch/defigent_wake_queue.jsonl') if 'anon-1792626' in l]
print('\nen la wake queue: {} entradas — replyExpected={}'.format(len(wq), wq[0].get('replyExpected') if wq else '?'))
