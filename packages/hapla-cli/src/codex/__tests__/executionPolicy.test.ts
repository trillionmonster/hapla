import { describe, expect, it } from 'vitest';
import { resolveCodexExecutionPolicy } from '../executionPolicy';

describe('resolveCodexExecutionPolicy', () => {
    it('retains native approval inside the external sandbox', () => {
        const policy = resolveCodexExecutionPolicy('default', true);

        expect(policy).toEqual({
            approvalPolicy: 'untrusted',
            sandbox: 'workspace-write',
        });
    });

    it('retains the explicit read-only boundary inside a managed sandbox',()=>{
        expect(resolveCodexExecutionPolicy('read-only',true)).toEqual({approvalPolicy:'never',sandbox:'read-only'});
    });
    it('maps codex default mode to untrusted + workspace-write without managed sandbox', () => {
        const policy = resolveCodexExecutionPolicy('default', false);

        expect(policy).toEqual({
            approvalPolicy: 'untrusted',
            sandbox: 'workspace-write',
        });
    });

    it('maps read-only mode to never + read-only without managed sandbox', () => {
        const policy = resolveCodexExecutionPolicy('read-only', false);

        expect(policy).toEqual({
            approvalPolicy: 'never',
            sandbox: 'read-only',
        });
    });

    it('maps YOLO to the supported non-interactive policy', () => {
        const policy = resolveCodexExecutionPolicy('yolo', false);

        expect(policy).toEqual({
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });
    });

    it('does not send the removed on-failure policy for safe YOLO', () => {
        const policy = resolveCodexExecutionPolicy('safe-yolo', false);

        expect(policy).toEqual({
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
        });
    });
});
