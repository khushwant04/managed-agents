import { describe, expectTypeOf, it } from 'vitest';
import type { Client, Deployment, Event, EventType, InvokeResult, ResponseOf, Session } from '../src/index.js';

// These are checked by `tsc --noEmit` (and vitest's typecheck); the bodies never run.
describe('types', () => {
  it('event type is a literal union and text is a string', () => {
    expectTypeOf<EventType>().toEqualTypeOf<Event['type']>();
    expectTypeOf<'message.agent.delta'>().toMatchTypeOf<EventType>();
    // @ts-expect-error not an event type
    expectTypeOf<'message.agent.deltas'>().toMatchTypeOf<EventType>();
    expectTypeOf<Event['text']>().toEqualTypeOf<string>();
    expectTypeOf<Event['seq']>().toEqualTypeOf<number>();
  });

  it('call() is checked against the OpenAPI paths', () => {
    expectTypeOf<ResponseOf<'/v1/deployments/{ref}', 'get'>>().toEqualTypeOf<Deployment>();
    expectTypeOf<ResponseOf<'/v1/sessions/{session_id}', 'get'>>().toEqualTypeOf<Session>();
    expectTypeOf<ResponseOf<'/v1/deployments/{ref}', 'delete'>>().toEqualTypeOf<void>();
    expectTypeOf<Awaited<ReturnType<Client['run']>>>().toEqualTypeOf<InvokeResult>();
    const typecheckOnly = (c: Client) => {
      void c.call('get', '/v1/usage', { query: { days: 1 } });
      // @ts-expect-error unknown path
      void c.call('get', '/v1/nope');
      // @ts-expect-error wrong method for the path
      void c.call('put', '/v1/usage');
      // @ts-expect-error missing path params
      void c.call('get', '/v1/deployments/{ref}', {});
      // @ts-expect-error body does not match SecretBody
      void c.call('post', '/v1/secrets', { body: { name: 'X' } });
    };
    void typecheckOnly;
  });
});
