import { describe, expect, it } from 'vitest';
import {
  ApiUpdateMachineStateSchema,
  ApiUpdateNewMachineSchema,
  ApiUpdateNewMessageSchema,
  ApiUpdateSessionStateSchema,
  CoreUpdateContainerSchema,
  MessageContentSchema,
  SessionProtocolMessageSchema,
} from './messages';
import {
  AgentMessageSchema,
  LegacyMessageContentSchema,
  UserMessageSchema,
} from './legacyProtocol';

describe('shared wire message schemas', () => {
  it('parses a new-message update', () => {
    const parsed = ApiUpdateNewMessageSchema.safeParse({
      t: 'new-message',
      sid: 'session-1',
      message: {
        id: 'msg-1',
        seq: 10,
        localId: null,
        content: {
          t: 'encrypted',
          c: 'ZmFrZS1lbmNyeXB0ZWQ=',
        },
        createdAt: 123,
        updatedAt: 124,
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('parses update-session with nullable agentState value', () => {
    const parsed = ApiUpdateSessionStateSchema.safeParse({
      t: 'update-session',
      id: 'session-1',
      metadata: {
        version: 2,
        value: 'abc',
      },
      agentState: {
        version: 3,
        value: null,
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('preserves the last human question index without requiring metadata changes', () => {
    expect(ApiUpdateSessionStateSchema.parse({
      t: 'update-session', id: 's', lastUserMessageAt: 1234, lastUserMessageIndexedSeq: 12,
    })).toEqual({
      t: 'update-session', id: 's', lastUserMessageAt: 1234, lastUserMessageIndexedSeq: 12,
    });
    expect(ApiUpdateSessionStateSchema.parse({
      t: 'update-session', id: 'empty', lastUserMessageAt: null, lastUserMessageIndexedSeq: 8,
    }).lastUserMessageAt).toBeNull();
    expect(ApiUpdateSessionStateSchema.safeParse({
      t: 'update-session', id: 's', lastUserMessageIndexedSeq: -1,
    }).success).toBe(false);
  });

  it('parses update-machine with optional activity fields', () => {
    const parsed = ApiUpdateMachineStateSchema.safeParse({
      t: 'update-machine',
      machineId: 'machine-1',
      metadata: {
        version: 1,
        value: 'abc',
      },
      daemonState: {
        version: 2,
        value: 'def',
      },
      active: true,
      activeAt: 12345,
    });

    expect(parsed.success).toBe(true);
  });

  it('parses new-machine with its encrypted data key', () => {
    const parsed = ApiUpdateNewMachineSchema.safeParse({
      t: 'new-machine',
      machineId: 'machine-1',
      seq: 1,
      metadata: 'encrypted-metadata',
      metadataVersion: 1,
      daemonState: null,
      daemonStateVersion: 0,
      dataEncryptionKey: 'encrypted-key',
      active: false,
      activeAt: 12345,
      createdAt: 12345,
      updatedAt: 12345,
    });

    expect(parsed.success).toBe(true);
  });

  it('parses container updates for all shared update variants', () => {
    const examples = [
      {
        id: 'upd-1',
        seq: 1,
        body: {
          t: 'new-message',
          sid: 'session-1',
          message: {
            id: 'msg-1',
            seq: 1,
            localId: null,
            content: { t: 'encrypted', c: 'x' },
            createdAt: 1,
            updatedAt: 1,
          },
        },
        createdAt: 1,
      },
      {
        id: 'upd-2',
        seq: 2,
        body: {
          t: 'update-session',
          id: 'session-1',
          metadata: null,
          agentState: {
            version: 1,
            value: null,
          },
        },
        createdAt: 2,
      },
      {
        id: 'upd-3',
        seq: 3,
        body: {
          t: 'update-machine',
          machineId: 'machine-1',
          metadata: null,
          daemonState: null,
        },
        createdAt: 3,
      },
      {
        id: 'upd-4',
        seq: 4,
        body: {
          t: 'new-machine',
          machineId: 'machine-1',
          seq: 1,
          metadata: 'encrypted-metadata',
          metadataVersion: 1,
          daemonState: null,
          daemonStateVersion: 0,
          dataEncryptionKey: 'encrypted-key',
          active: false,
          activeAt: 4,
          createdAt: 4,
          updatedAt: 4,
        },
        createdAt: 4,
      },
    ];

    for (const sample of examples) {
      expect(CoreUpdateContainerSchema.safeParse(sample).success).toBe(true);
    }
  });

  it('parses legacy decrypted user message payload', () => {
    const parsed = UserMessageSchema.safeParse({
      role: 'user',
      content: {
        type: 'text',
        text: 'fix this test',
      },
      meta: {
        sentFrom: 'mobile',
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('parses legacy decrypted agent message payload', () => {
    const parsed = AgentMessageSchema.safeParse({
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'message',
          message: 'done',
        },
      },
      meta: {
        sentFrom: 'cli',
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('parses legacy message discriminated union', () => {
    const userParsed = LegacyMessageContentSchema.safeParse({
      role: 'user',
      content: {
        type: 'text',
        text: 'hello',
      },
    });
    const agentParsed = LegacyMessageContentSchema.safeParse({
      role: 'agent',
      content: {
        type: 'event',
        data: { type: 'ready' },
      },
    });

    expect(userParsed.success).toBe(true);
    expect(agentParsed.success).toBe(true);
  });

  it('parses modern session protocol wrapper payload', () => {
    const parsed = SessionProtocolMessageSchema.safeParse({
      role: 'session',
      content: {
        id: 'msg-1',
        time: 1000,
        role: 'agent',
        turn: 'turn-1',
        ev: {
          t: 'text',
          text: 'hello',
        },
      },
      meta: {
        sentFrom: 'cli',
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('parses top-level message discriminated union for legacy and modern roles', () => {
    const userParsed = MessageContentSchema.safeParse({
      role: 'user',
      content: {
        type: 'text',
        text: 'hello from user',
      },
    });
    const agentParsed = MessageContentSchema.safeParse({
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'message',
          message: 'hello from agent',
        },
      },
    });
    const modernParsed = MessageContentSchema.safeParse({
      role: 'session',
      content: {
        id: 'msg-2',
        time: 2000,
        role: 'agent',
        turn: 'turn-2',
        ev: {
          t: 'text',
          text: 'hello from session protocol',
        },
      },
    });

    expect(userParsed.success).toBe(true);
    expect(agentParsed.success).toBe(true);
    expect(modernParsed.success).toBe(true);
  });
});
