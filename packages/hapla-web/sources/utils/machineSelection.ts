import type { Machine } from '@/sync/storageTypes';
import { isMachineOnline } from '@/utils/machineUtils';

function compareMachinePriority(a: Machine, b: Machine): number {
    const aPriority = isMachineOnline(a) ? 0 : 1;
    const bPriority = isMachineOnline(b) ? 0 : 1;
    return aPriority - bPriority;
}

export function resolvePreferredMachineId(
    machines: Machine[],
    selectedMachineId: string | null,
): string | null {
    if (machines.length === 0) {
        return null;
    }

    if (selectedMachineId) {
        const selectedMachine = machines.find((machine) => machine.id === selectedMachineId);
        // A remembered machine is only useful as the default while it is
        // actually online. Keeping a disconnected daemon selected makes the
        // new-session screen look broken even when another launcher is ready.
        if (selectedMachine && isMachineOnline(selectedMachine)) {
            return selectedMachineId;
        }
    }

    const preferredMachine = [...machines].sort(compareMachinePriority)[0];
    return preferredMachine?.id ?? null;
}
