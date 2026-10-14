import { describe, expectTypeOf, it } from 'vitest';
import type { AgentSpec, Client, Deployment, ErrorBody, Event, EventType, InvokeResult, ResponseOf, Schemas, Session } from '../src/index.js';
import type { APIError } from '../src/index.js';

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
    expectTypeOf<ResponseOf<'/v1/sessions/{session_id}/artifacts/{artifact_id}', 'get'>>().toEqualTypeOf<Uint8Array>();
    expectTypeOf<Awaited<ReturnType<Client['sessions']['download']>>>().toEqualTypeOf<Uint8Array>();
    expectTypeOf<Parameters<Client['agents']['register']>[0]>().toEqualTypeOf<Schemas['AgentSpec']>();
    expectTypeOf<AgentSpec>().toEqualTypeOf<Schemas['AgentSpec']>();
    expectTypeOf<APIError['error']>().toEqualTypeOf<ErrorBody | undefined>();
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
      // @ts-expect-error binary responses must be read raw
      void c.call('get', '/v1/sessions/{session_id}/artifacts/{artifact_id}', { path: { session_id: 's', artifact_id: 'a' } });
      // @ts-expect-error tools must be ToolRefs
      void c.agents.register({ name: 'x', models: ['m'], tools: [{ url: 'u' }] });
      // @ts-expect-error deployment updates are DeploymentUpdate
      void c.deployments.update('d', { agent: 'other' });
    };
    void typecheckOnly;
  });
});
