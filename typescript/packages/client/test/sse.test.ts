import { describe, expect, it } from 'vitest';
import { SSEParser, parseSSE } from '../src/index.js';

function parseAll(...chunks: string[]) {
  const p = new SSEParser();
  return chunks.flatMap((c) => p.feed(c));
}

function streamOf(chunks: (string | Uint8Array)[], opts: { error?: boolean } = {}): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(c) {
      const x = chunks[i++];
      if (x !== undefined) c.enqueue(typeof x === 'string' ? enc.encode(x) : x);
      else if (opts.error) c.error(new TypeError('terminated'));
      else c.close();
    },
  });
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe('SSEParser', () => {
  it('parses id, event and data', () => {
    expect(parseAll('id: 7\nevent: tool.call\ndata: {"a":1}\n\n')).toEqual([{ id: '7', event: 'tool.call', data: '{"a":1}' }]);
  });

  it('joins multi-line data with \\n', () => {
    expect(parseAll('data: line one\ndata: line two\ndata:\ndata:  indented\n\n')[0]?.data).toBe('line one\nline two\n\n indented');
  });

  it('ignores comments and keepalives', () => {
    expect(parseAll(': keepalive\n\n: hi\ndata: x\n\n')).toEqual([{ event: 'message', data: 'x', id: undefined }]);
  });

  it('handles CRLF and bare CR line endings', () => {
    expect(parseAll('id: 1\r\ndata: a\r\n\r\nid: 2\rdata: b\r\r').map((m) => [m.id, m.data])).toEqual([
      ['1', 'a'],
      ['2', 'b'],
    ]);
  });

  it('handles a CRLF split across chunks without an extra blank line', () => {
    const msgs = parseAll('data: a\r', '\ndata: b\r', '\n\r', '\n');
    expect(msgs).toEqual([{ event: 'message', data: 'a\nb', id: undefined }]);
  });

  it('handles fields split at arbitrary chunk boundaries', () => {
    const text = 'id: 12\nevent: message.agent.delta\ndata: {"text":"hello"}\n\n';
    for (let i = 1; i < text.length; i++) {
      expect(parseAll(text.slice(0, i), text.slice(i))).toEqual([{ id: '12', event: 'message.agent.delta', data: '{"text":"hello"}' }]);
    }
  });

  it('keeps the last event id across messages and resets the event type', () => {
    const msgs = parseAll('id: 3\nevent: a\ndata: 1\n\ndata: 2\n\n');
    expect(msgs.map((m) => [m.id, m.event])).toEqual([
      ['3', 'a'],
      ['3', 'message'],
    ]);
  });

  it('does not dispatch a message without data, and handles fields without a colon', () => {
    expect(parseAll('event: x\n\nid: 9\n\n')).toEqual([]);
    expect(parseAll('data\n\n')).toEqual([{ event: 'message', data: '', id: undefined }]);
  });

  it('reads retry and ignores ids containing NUL', () => {
    const p = new SSEParser();
    expect(p.feed('retry: 1500\nid: a\0b\ndata: x\n\n')).toEqual([{ event: 'message', data: 'x', id: undefined, retry: 1500 }]);
    expect(p.lastEventId).toBeUndefined();
  });

  it('strips a leading BOM', () => {
    expect(parseAll('﻿data: x\n\n')[0]?.data).toBe('x');
  });
});

describe('parseSSE', () => {
  it('decodes UTF-8 split inside a multi-byte character', async () => {
    const bytes = new TextEncoder().encode('data: héllo ✓\n\n');
    const msgs = await collect(parseSSE(streamOf([bytes.slice(0, 8), bytes.slice(8, 15), bytes.slice(15)])));
    expect(msgs.map((m) => m.data)).toEqual(['héllo ✓']);
  });

  it('discards an unterminated final message', async () => {
    expect((await collect(parseSSE(streamOf(['data: done\n\ndata: {"partial"'])))).map((m) => m.data)).toEqual(['done']);
  });

  it('propagates stream errors after yielding complete messages', async () => {
    const seen: string[] = [];
    await expect(async () => {
      for await (const m of parseSSE(streamOf(['data: a\n\n'], { error: true }))) seen.push(m.data);
    }).rejects.toThrow('terminated');
    expect(seen).toEqual(['a']);
  });

  it('cancels the body when the consumer stops early', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: 1\n\ndata: 2\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const m of parseSSE(body)) {
      expect(m.data).toBe('1');
      break;
    }
    expect(cancelled).toBe(true);
  });

  it('stops when the signal aborts', async () => {
    const ac = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: 1\n\n'));
      },
    });
    const seen: string[] = [];
    await expect(async () => {
      for await (const m of parseSSE(body, ac.signal)) {
        seen.push(m.data);
        ac.abort();
      }
    }).rejects.toThrow();
    expect(seen).toEqual(['1']);
  });
});
