import { useUnistyles } from 'react-native-unistyles';
import * as React from 'react';
import { ScrollView } from 'react-native';
import { Text } from '../StyledText';
import { Typography } from '@/constants/Typography';

export function MathRenderer(props: { content: string; displayMode?: boolean }) {
    const { theme } = useUnistyles();
    const text = <Text style={{ ...Typography.mono(), fontSize: theme.typography.code.fontSize }}>{props.content}</Text>;
    return props.displayMode ? <ScrollView horizontal>{text}</ScrollView> : text;
}
