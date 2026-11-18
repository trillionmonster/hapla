import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { resolveMachineWorkspaceRoot, resolveServerUrl, resolveWebappUrl } from './configuration'
import { validatePath } from './modules/common/pathSecurity'

describe('Hapla endpoint configuration', () => {
  it('defaults to loopback services instead of upstream Happy infrastructure', () => {
    expect(resolveServerUrl({})).toBe('http://127.0.0.1:12345')
    expect(resolveWebappUrl({})).toBe('http://127.0.0.1:12345')
  })

  it('uses only HAPLA endpoint variables', () => {
    expect(resolveServerUrl({ HAPLA_SERVER_URL: 'https://hapla.example' }))
      .toBe('https://hapla.example')
    expect(resolveWebappUrl({ HAPLA_WEBAPP_URL: 'https://hapla-web.example' }))
      .toBe('https://hapla-web.example')
  })

  it('does not consume another project\'s legacy endpoint variables', () => {
    expect(resolveServerUrl({ HAPPY_SERVER_URL: 'https://foreign.example' })).toBe('http://127.0.0.1:12345')
    expect(resolveWebappUrl({ HAPPY_WEBAPP_URL: 'https://foreign-web.example' })).toBe('http://127.0.0.1:12345')
  })
})

describe('machine workspace root', () => {
  it('keeps the OS home as the default independently of the daemon working directory', () => {
    expect(resolveMachineWorkspaceRoot({})).toBe(homedir())
    expect(resolveMachineWorkspaceRoot({ HAPLA_WORKSPACE_ROOT: '   ' })).toBe(homedir())
  })

  it('allows a container workspace outside the OS home without allowing sibling paths', () => {
    const root = resolveMachineWorkspaceRoot({ HAPLA_WORKSPACE_ROOT: ' /workspace/ ' })
    expect(validatePath('/workspace', root).valid).toBe(true)
    expect(validatePath('packages/package.json', root).resolvedPath).toBe('/workspace/packages/package.json')
    expect(validatePath('/workspace-other', root).valid).toBe(false)
    expect(validatePath('../state/client/access.key', root).valid).toBe(false)
  })

  it('rejects relative roots instead of making access depend on process.cwd()', () => {
    expect(() => resolveMachineWorkspaceRoot({ HAPLA_WORKSPACE_ROOT: 'workspace' }))
      .toThrow('HAPLA_WORKSPACE_ROOT must be an absolute path')
  })
})
