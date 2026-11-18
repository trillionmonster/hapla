import { Dimensions, useWindowDimensions } from 'react-native';
import { useMemo } from 'react';
import {
    calculateDeviceDimensions,
    determineDeviceType,
    calculateHeaderHeight,
} from './deviceCalculations';

export { calculateDeviceDimensions, determineDeviceType, calculateHeaderHeight };

/** A persistent two-column workspace needs room for the 260px sidebar and chat. */
export const WEB_SIDEBAR_BREAKPOINT = 1024;
export const WEB_COMPACT_BREAKPOINT = 700;

export function getHeaderHeight(): number {
    return 56;
}

export function getDeviceType(): 'phone' | 'tablet' {
    return Dimensions.get('window').width >= WEB_SIDEBAR_BREAKPOINT ? 'tablet' : 'phone';
}

export function useDeviceType(): 'phone' | 'tablet' {
    const { width } = useWindowDimensions();
    return width >= WEB_SIDEBAR_BREAKPOINT ? 'tablet' : 'phone';
}

export function useIsTablet(): boolean {
    return useDeviceType() === 'tablet';
}

export function useIsLandscape(): boolean {
    const { width, height } = useWindowDimensions();
    return width > height;
}

export function useHeaderHeight(): number {
    const { width } = useWindowDimensions();
    return useMemo(() => width < 380 ? 52 : 56, [width]);
}
