import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { runCodex } from '@/codex/runCodex'
import { extractCodexResumeFlag, extractCodexStartedByFlag, extractHaplaStartingModeFlag } from '@/codex/cliArgs'
import { extractNoSandboxFlag } from '@/utils/sandboxFlags'
import { ensureDaemonRunning } from '@/daemon/ensureDaemonRunning'

export async function handleCodexCommand(args: string[]): Promise<void> {
  const sandboxArgs = extractNoSandboxFlag(args)
  const startingModeArgs = extractHaplaStartingModeFlag(sandboxArgs.args)
  const resumeArgs = extractCodexResumeFlag(startingModeArgs.args)
  const startedByArgs = extractCodexStartedByFlag(resumeArgs.args)

  const { credentials } = await authAndSetupMachineIfNeeded()
  await ensureDaemonRunning()

  await runCodex({
    credentials,
    startedBy: startedByArgs.startedBy,
    noSandbox: sandboxArgs.noSandbox,
    resumeThreadId: resumeArgs.resumeThreadId ?? undefined,
    codexArgs: startedByArgs.args,
  })
}
